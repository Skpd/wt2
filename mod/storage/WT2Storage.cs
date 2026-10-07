using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using UnityEngine;

namespace WT2Storage
{
    // "Stack" button next to the storage window's Sort button (and a hotkey, F1 by default): stores every
    // inventory stack whose item kind is already on the open storage page. Each stack goes through the
    // inventory "Store" action - what the game does when you click an item while a container is open.
    [BepInPlugin("skpd.wt2.storage", "WT2 Storage", "0.1.0")]
    public class StoragePlugin : BaseUnityPlugin
    {
        const float SendInterval = 0.1f;

        static readonly FieldInfo PanelField = typeof(WTUIContainer).GetField("panel", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly FieldInfo SortButtonField = typeof(WTUIContainer).GetField("sortButton", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly MethodInfo IndexInTab = typeof(WTUIContainer).GetMethod("IndexInTab", BindingFlags.NonPublic | BindingFlags.Instance);

        ConfigEntry<KeyboardShortcut> stackKey;
        ConfigEntry<bool> showButton;

        readonly Queue<int> queue = new Queue<int>();
        int queueTab;
        float nextSend;
        string message;
        float messageUntil;
        readonly HashSet<string> reportedErrors = new HashSet<string>();

        void Awake()
        {
            stackKey = Config.Bind("Keys", "StackToStorage", new KeyboardShortcut(KeyCode.F1),
                "Store inventory stacks of the kinds already on the open storage page.");
            showButton = Config.Bind("UI", "ShowButton", true, "Show a Stack button next to the storage window's Sort button.");
            Logger.LogInfo(string.Format("awake: container panel {0}, sort button {1}, IndexInTab {2}",
                PanelField != null ? "ok" : "MISSING", SortButtonField != null ? "ok" : "MISSING", IndexInTab != null ? "ok" : "MISSING"));
        }

        void Update()
        {
            try
            {
                if (stackKey.Value.IsDown()) StackToOpenPage();
                Pump();
            }
            catch (Exception e) { Report("Update", e); }
        }

        void StackToOpenPage()
        {
            var p = Player.localPlayer;
            var ui = WTUIContainer.instance;
            int tab;
            if (p == null || ui == null || GameManager.instance == null || !GameManager.instance.IsContainerWindowOpen(out tab))
            {
                Show("open a storage first");
                return;
            }
            var kinds = new HashSet<string>();
            if (ui.slots != null)
                for (int i = 0; i < ui.slots.Length; i++)
                    if (ui.slots[i].amount > 0 && InOpenPage(ui, i)) kinds.Add(ui.slots[i].item.name);

            queue.Clear();
            var names = new HashSet<string>();
            for (int i = 0; i < p.inventory.Count; i++)
            {
                var slot = p.inventory[i];
                if (slot.amount > 0 && kinds.Contains(slot.item.name)) { queue.Enqueue(i); names.Add(slot.item.name); }
            }
            queueTab = tab;
            nextSend = Time.time;
            string text = queue.Count == 0 ? "nothing in your bags matches this page"
                : "storing " + queue.Count + " stack(s): " + string.Join(", ", names.OrderBy(s => s).ToArray());
            Show(text);
            Logger.LogInfo(text + " (page has " + kinds.Count + " kind(s), tab " + tab + ")");
        }

        void Pump()
        {
            if (queue.Count == 0 || Time.time < nextSend) return;
            int tab;
            var p = Player.localPlayer;
            if (p == null || GameManager.instance == null || !GameManager.instance.IsContainerWindowOpen(out tab) || tab != queueTab)
            {
                Logger.LogInfo("storage closed or page changed, " + queue.Count + " stack(s) not stored");
                queue.Clear();
                return;
            }
            p.CmdInventoryItemAction(queue.Dequeue(), ItemActionType.Store, tab);
            nextSend = Time.time + SendInterval;
        }

        static bool InOpenPage(WTUIContainer ui, int index)
        {
            return IndexInTab == null || (bool)IndexInTab.Invoke(ui, new object[] { index });
        }

        void Show(string text)
        {
            message = text;
            messageUntil = Time.time + 4f;
        }

        void OnGUI()
        {
            try
            {
                if (!showButton.Value) return;
                var ui = WTUIContainer.instance;
                if (ui == null || PanelField == null) return;
                var panel = PanelField.GetValue(ui) as GameObject;
                if (panel == null || !panel.activeInHierarchy) return;

                // Anchor to the Sort button if we can find it on screen, else to the panel's top-right corner.
                Rect anchor;
                var sort = SortButtonField == null ? null : SortButtonField.GetValue(ui) as Component;
                Rect button;
                if (sort != null && sort.gameObject.activeInHierarchy && ScreenRect(sort.transform as RectTransform, out anchor))
                    button = new Rect(anchor.xMin - 74, anchor.center.y - 12, 70, 24);
                else if (ScreenRect(panel.transform as RectTransform, out anchor))
                    button = new Rect(anchor.xMax - 74, anchor.yMin - 28, 70, 24);
                else return;

                if (GUI.Button(button, new GUIContent("Stack", "Store your stacks of the kinds already on this page (" + stackKey.Value + ")")))
                    StackToOpenPage();
                if (message != null && Time.time < messageUntil)
                    GUI.Label(new Rect(button.xMin - 330, button.yMax + 2, 400, 22), message);
            }
            catch (Exception e) { Report("OnGUI", e); }
        }

        // RectTransform -> IMGUI screen rect (the game's UI canvases are screen-space overlay).
        static bool ScreenRect(RectTransform rt, out Rect rect)
        {
            rect = default(Rect);
            if (rt == null) return false;
            var corners = new Vector3[4];
            rt.GetWorldCorners(corners);
            Vector2 a = RectTransformUtility.WorldToScreenPoint(null, corners[0]);
            Vector2 b = RectTransformUtility.WorldToScreenPoint(null, corners[2]);
            rect = Rect.MinMaxRect(Mathf.Min(a.x, b.x), Screen.height - Mathf.Max(a.y, b.y), Mathf.Max(a.x, b.x), Screen.height - Mathf.Min(a.y, b.y));
            return rect.width > 0 && rect.height > 0;
        }

        void Report(string where, Exception e)
        {
            if (reportedErrors.Add(where + e.GetType().Name + e.Message))
                Logger.LogError(where + " failed: " + e);
        }
    }
}
