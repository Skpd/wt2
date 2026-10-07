using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using Mirror;
using UnityEngine;

namespace WT2Finder
{
    // Search window (F6) listing the resource nodes and mobs the client currently knows about;
    // tracked kinds get on-screen markers with distance, or edge arrows when off-screen.
    // Other players are deliberately not listed.
    [BepInPlugin("skpd.wt2.finder", "WT2 Finder", "0.2.0")]
    public class FinderPlugin : BaseUnityPlugin
    {
        const string SearchControl = "wt2finder.search";
        const float ScanInterval = 0.5f;
        const float EdgeMargin = 40f;

        static readonly FieldInfo WorldObjectsField =
            typeof(WTObject).GetField("worldObjects", BindingFlags.NonPublic | BindingFlags.Static);

        // read by the input guard patches
        internal static bool SearchFocused;
        internal static bool CursorOverWindow;

        class Kind
        {
            public string Key, Id, Name;
            public bool IsMob;
            public int Count;
            public float Nearest = float.MaxValue;
        }

        class Target
        {
            public Transform Transform;   // live object; null for fixed server markers
            public Vector3 Fixed;
            public bool IsFixed;
            public string Name;
            public Color Color;
            public float Distance;

            public bool Valid { get { return IsFixed || Transform != null; } }
            public Vector3 Position { get { return IsFixed ? Fixed : Transform.position; } }
        }

        ConfigEntry<KeyboardShortcut> toggleKey;
        ConfigEntry<string> trackedConfig;
        ConfigEntry<float> maxDistance;
        ConfigEntry<int> maxMarkers;
        ConfigEntry<int> maxLabels;
        ConfigEntry<bool> verbose;

        Harmony harmony;
        bool windowOpen;
        Rect windowRect = new Rect(20, 280, 420, 460);
        string query = "";
        Vector2 scroll;
        float nextScan;
        HashSet<string> tracked;
        List<Kind> kinds = new List<Kind>();
        List<Target> targets = new List<Target>();
        readonly Dictionary<string, string> names = new Dictionary<string, string>();
        Texture2D arrow, dot;
        GUIStyle labelStyle, shadowStyle;

        // diagnostics
        int updates, guis;
        bool hadPlayer;
        string lastScanSummary = "no scan yet";
        float nextScanLog;
        readonly HashSet<string> reportedErrors = new HashSet<string>();

        static readonly Color ResourceColor = new Color(0.45f, 1f, 0.45f);
        static readonly Color MobColor = new Color(1f, 0.7f, 0.25f);
        static readonly Color DangerColor = new Color(1f, 0.3f, 0.3f);
        static readonly Color ServerColor = new Color(0.35f, 0.85f, 1f);
        ConfigEntry<bool> showServerMarkers;

        void Awake()
        {
            toggleKey = Config.Bind("Keys", "ToggleWindow", new KeyboardShortcut(KeyCode.F6));
            trackedConfig = Config.Bind("Finder", "Tracked", "",
                "Tracked kinds, e.g. obj:IronDeposit,mob:Wolf (managed from the window).");
            maxDistance = Config.Bind("Finder", "MaxDistance", 500f, "Ignore anything farther than this (meters).");
            maxMarkers = Config.Bind("Finder", "MaxMarkers", 60, "Draw at most this many markers (nearest first).");
            maxLabels = Config.Bind("Finder", "MaxLabels", 15, "Only the nearest N markers get a name/distance label.");
            verbose = Config.Bind("Debug", "Verbose", true, "Log lifecycle, key presses and scan summaries; show a debug line.");
            showServerMarkers = Config.Bind("Finder", "ShowServerMarkers", true,
                "Draw the direction points the server sends (quest targets, search potions), at any distance.");
            ServerMarkers.Log = message => Logger.LogInfo(message);
            tracked = new HashSet<string>(trackedConfig.Value.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0));
            PublishTracked();
            arrow = MakeArrow(32);
            dot = MakeDot(16);
            harmony = new Harmony("skpd.wt2.finder");
            int patched = 0;
            try
            {
                harmony.PatchAll(typeof(InputGuard));
                harmony.PatchAll(typeof(DirectionPointHooks));
                patched = harmony.GetPatchedMethods().Count();
            }
            catch (Exception e) { Report("Harmony patching", e); }
            Logger.LogInfo(string.Format("awake: worldObjects field {0}, {1} input guard patch(es), tracking '{2}'",
                WorldObjectsField != null ? "ok" : "MISSING", patched, trackedConfig.Value));
        }

        void OnDestroy()
        {
            // Undo patches and release textures so ScriptEngine reloads don't stack them.
            if (harmony != null) harmony.UnpatchSelf();
            SearchFocused = false;
            CursorOverWindow = false;
            if (arrow != null) Destroy(arrow);
            if (dot != null) Destroy(dot);
            Logger.LogInfo("destroyed after " + updates + " update(s)");
        }

        void Update()
        {
            if (++updates == 1) Trace("first Update tick");
            try { UpdateCore(); }
            catch (Exception e) { Report("Update", e); }
        }

        void UpdateCore()
        {
            TrackPlayer();
            if (toggleKey.Value.IsDown())
            {
                windowOpen = !windowOpen;
                Trace("toggle key pressed, window " + (windowOpen ? "open" : "closed"));
            }
            if (!windowOpen) { SearchFocused = false; CursorOverWindow = false; }
            else
            {
                Vector2 mouse = Input.mousePosition;
                CursorOverWindow = windowRect.Contains(new Vector2(mouse.x, Screen.height - mouse.y));
            }
            if (Time.time >= nextScan)
            {
                nextScan = Time.time + ScanInterval;
                Scan();
            }
        }

        void Scan()
        {
            var player = Player.localPlayer;
            kinds.Clear();
            targets.Clear();
            if (player == null) { lastScanSummary = "no local player"; return; }
            Vector3 origin = player.transform.position;
            var byKey = new Dictionary<string, Kind>();
            int objectCount = 0, typedObjects = 0, spawnedCount = 0, mobCount = 0;

            var objects = WorldObjectsField == null ? null : WorldObjectsField.GetValue(null) as Dictionary<int, WTObject>;
            if (objects != null)
                foreach (var o in objects.Values)
                {
                    objectCount++;
                    if (o == null || o.worldType == null) continue;
                    typedObjects++;
                    Add(byKey, "obj:" + o.worldType.name, o.worldType.name, false, o, o.transform, origin, ResourceColor);
                }

            foreach (var ni in NetworkIdentity.spawned.Values)
            {
                spawnedCount++;
                if (ni == null) continue;
                var e = ni.GetComponent<Entity>();
                if (e == null || e is Player || e.entityType == null || e.IsStateDead()) continue;
                mobCount++;
                var danger = e.entityType.danger.ToString();
                Color color = danger == "Elite" || danger == "Boss" ? DangerColor : MobColor;
                Add(byKey, "mob:" + e.entityType.name, e.entityType.name, true, e, e.transform, origin, color);
            }

            kinds = byKey.Values.OrderBy(k => k.IsMob).ThenBy(k => k.Name).ToList();
            targets = targets.OrderBy(t => t.Distance).Take(maxMarkers.Value).ToList();
            if (showServerMarkers.Value)
                foreach (var pt in ServerMarkers.Points.Values)
                    targets.Add(new Target { Fixed = pt.Position, IsFixed = true, Name = pt.Label, Color = ServerColor,
                                             Distance = Vector3.Distance(origin, pt.Position) });
            lastScanSummary = string.Format("objects {0}{1} ({2} typed), spawned {3} ({4} mobs), kinds {5}, markers {6}",
                objectCount, objects == null ? " [registry null]" : "", typedObjects, spawnedCount, mobCount, kinds.Count, targets.Count);
            if (verbose.Value && Time.time >= nextScanLog)
            {
                nextScanLog = Time.time + 10f;
                Logger.LogInfo("scan: " + lastScanSummary);
            }
        }

        void Add(Dictionary<string, Kind> byKey, string key, string id, bool isMob, Component source,
                 Transform transform, Vector3 origin, Color color)
        {
            float dist = Vector3.Distance(origin, transform.position);
            if (dist > maxDistance.Value) return;
            Kind k;
            if (!byKey.TryGetValue(key, out k))
                byKey[key] = k = new Kind { Key = key, Id = id, Name = LocalizedName(key, source, id), IsMob = isMob };
            k.Count++;
            k.Nearest = Mathf.Min(k.Nearest, dist);
            if (tracked.Contains(key))
                targets.Add(new Target { Transform = transform, Name = k.Name, Color = color, Distance = dist });
        }

        string LocalizedName(string key, Component source, string fallback)
        {
            string name;
            if (names.TryGetValue(key, out name)) return name;
            try
            {
                var o = source as WTObject;
                var e = source as Entity;
                name = o != null ? o.GetLocalizedName() : e != null ? e.GetLocalizedName() : null;
            }
            catch (Exception ex) { Report("GetLocalizedName(" + key + ")", ex); name = null; }
            if (string.IsNullOrEmpty(name)) name = fallback;
            names[key] = name;
            return name;
        }

        void OnGUI()
        {
            if (++guis == 1) Trace("first OnGUI call");
            try
            {
                EnsureStyles();
                if (verbose.Value)
                    GUI.Label(new Rect(10, 115, 900, 22), string.Format("Finder [F6] debug: updates {0}, gui {1}, {2}",
                        updates, guis, lastScanSummary), shadowStyle);
                if (Player.localPlayer == null) return;
                DrawMarkers();
                if (windowOpen)
                    windowRect = GUILayout.Window(0x57543246, windowRect, DrawWindow, "Finder (F6)");
            }
            catch (Exception e) { Report("OnGUI", e); }
        }

        void DrawWindow(int id)
        {
            GUILayout.BeginHorizontal();
            GUILayout.Label("Search", GUILayout.Width(50));
            GUI.SetNextControlName(SearchControl);
            query = GUILayout.TextField(query);
            GUILayout.EndHorizontal();
            SearchFocused = GUI.GetNameOfFocusedControl() == SearchControl;

            GUILayout.BeginHorizontal();
            GUILayout.Label("Tracking " + tracked.Count + " kind(s), " + targets.Count + " marker(s)");
            if (GUILayout.Button("Clear", GUILayout.Width(60))) { tracked.Clear(); SaveTracked(); }
            GUILayout.EndHorizontal();

            scroll = GUILayout.BeginScrollView(scroll);
            string q = query.Trim();
            bool? lastIsMob = null;
            foreach (var k in kinds)
            {
                if (q.Length > 0 && k.Name.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0
                    && k.Id.IndexOf(q, StringComparison.OrdinalIgnoreCase) < 0) continue;
                if (lastIsMob != k.IsMob) { GUILayout.Label(k.IsMob ? "— Mobs —" : "— Resources & objects —"); lastIsMob = k.IsMob; }
                bool on = tracked.Contains(k.Key);
                string text = string.Format("{0}  ×{1}  {2:0}m", k.Name, k.Count, k.Nearest);
                if (GUILayout.Toggle(on, text) != on)
                {
                    if (on) tracked.Remove(k.Key); else tracked.Add(k.Key);
                    Trace((on ? "untracked " : "tracked ") + k.Key);
                    SaveTracked();
                    nextScan = 0;
                }
            }
            GUILayout.BeginHorizontal();
            showServerMarkers.Value = GUILayout.Toggle(showServerMarkers.Value, "— Server markers (" + ServerMarkers.Points.Count + ") —");
            if (GUILayout.Button("Refresh", GUILayout.Width(70)))
                Trace(ServerMarkers.RequestAll(Player.localPlayer) ? "requested direction points" : "can't request direction points");
            GUILayout.EndHorizontal();
            var me = Player.localPlayer;
            foreach (var pt in ServerMarkers.Points.Values.OrderBy(p => me == null ? 0 : Vector3.Distance(me.transform.position, p.Position)))
                GUILayout.Label(string.Format("  {0}  {1:0}m", pt.Label,
                    me == null ? 0 : Vector3.Distance(me.transform.position, pt.Position)));
            foreach (var key in tracked.Where(t => kinds.All(k => k.Key != t)).ToList())
            {
                GUILayout.BeginHorizontal();
                GUILayout.Label(key.Substring(4) + "  (none in range)");
                if (GUILayout.Button("×", GUILayout.Width(24))) { tracked.Remove(key); SaveTracked(); }
                GUILayout.EndHorizontal();
            }
            GUILayout.EndScrollView();
            GUI.DragWindow();
        }

        void DrawMarkers()
        {
            var cam = Camera.main;
            var player = Player.localPlayer;
            if (targets.Count == 0) return;
            if (cam == null) { Report("DrawMarkers", new InvalidOperationException("Camera.main is null")); return; }
            var center = new Vector2(Screen.width / 2f, Screen.height / 2f);
            int labelled = 0;
            foreach (var t in targets)
            {
                if (!t.Valid) continue;
                float dist = Vector3.Distance(player.transform.position, t.Position);
                Vector3 sp = cam.WorldToScreenPoint(t.Position + Vector3.up * 1.5f);
                bool behind = sp.z < 0;
                if (behind) { sp.x = Screen.width - sp.x; sp.y = Screen.height - sp.y; }
                var pos = new Vector2(sp.x, Screen.height - sp.y);
                bool onScreen = !behind && pos.x > EdgeMargin && pos.x < Screen.width - EdgeMargin
                                && pos.y > EdgeMargin && pos.y < Screen.height - EdgeMargin;
                string label = labelled < maxLabels.Value ? t.Name + "  " + dist.ToString("0") + "m" : null;
                labelled++;

                GUI.color = t.Color;
                if (onScreen)
                {
                    GUI.DrawTexture(new Rect(pos.x - 6, pos.y - 6, 12, 12), dot);
                    GUI.color = Color.white;
                    if (label != null) Label(new Vector2(pos.x, pos.y + 16), label, t.Color);
                    continue;
                }

                Vector2 dir = (pos - center).normalized;
                if (dir == Vector2.zero) dir = Vector2.up;
                float sx = (center.x - EdgeMargin) / Mathf.Max(Mathf.Abs(dir.x), 1e-4f);
                float sy = (center.y - EdgeMargin) / Mathf.Max(Mathf.Abs(dir.y), 1e-4f);
                Vector2 edge = center + dir * Mathf.Min(sx, sy);
                float angle = Mathf.Atan2(dir.y, dir.x) * Mathf.Rad2Deg;
                Matrix4x4 saved = GUI.matrix;
                GUIUtility.RotateAroundPivot(angle, edge);
                GUI.DrawTexture(new Rect(edge.x - 14, edge.y - 14, 28, 28), arrow);
                GUI.matrix = saved;
                GUI.color = Color.white;
                if (label != null) Label(edge - dir * 34f, label, t.Color);
            }
            GUI.color = Color.white;
        }

        void Label(Vector2 at, string text, Color color)
        {
            var rect = new Rect(at.x - 110, at.y - 10, 220, 20);
            GUI.Label(new Rect(rect.x + 1, rect.y + 1, rect.width, rect.height), text, shadowStyle);
            labelStyle.normal.textColor = color;
            GUI.Label(rect, text, labelStyle);
        }

        void EnsureStyles()
        {
            if (labelStyle != null) return;
            labelStyle = new GUIStyle(GUI.skin.label) { alignment = TextAnchor.MiddleCenter, fontSize = 13, fontStyle = FontStyle.Bold };
            shadowStyle = new GUIStyle(labelStyle);
            shadowStyle.normal.textColor = Color.black;
        }

        // Other plugins (the gatherer) read the selection from AppDomain data: plugin assemblies are
        // renamed on every ScriptEngine reload, so they can't reference each other's types.
        public const string SharedTrackedKey = "skpd.wt2.finder.tracked";

        void PublishTracked()
        {
            AppDomain.CurrentDomain.SetData(SharedTrackedKey, trackedConfig.Value);
        }

        void SaveTracked()
        {
            trackedConfig.Value = string.Join(",", tracked.OrderBy(s => s).ToArray());
            PublishTracked();
        }

        void TrackPlayer()
        {
            bool has = Player.localPlayer != null;
            if (has == hadPlayer) return;
            hadPlayer = has;
            Trace(has ? "local player found: " + Player.localPlayer.GetType().Name + " at " + Player.localPlayer.transform.position
                      : "local player lost");
            // Points sent before this plugin (re)loaded were missed; ask for the full set again.
            if (has) Trace(ServerMarkers.RequestAll(Player.localPlayer) ? "requested direction points" : "CmdGetDirectionPoints not found");
            else ServerMarkers.Points.Clear();
        }

        void Trace(string message)
        {
            if (verbose.Value) Logger.LogInfo(message);
        }

        void Report(string where, Exception e)
        {
            if (reportedErrors.Add(where + e.GetType().Name + e.Message))
                Logger.LogError(where + " failed: " + e);
        }

        // White triangle pointing right (+x); tinted with GUI.color and rotated when drawn.
        static Texture2D MakeArrow(int size)
        {
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    float half = (size - x) * 0.5f;
                    bool inside = Mathf.Abs(y - size / 2f) <= half * 0.9f && x >= 2;
                    tex.SetPixel(x, y, inside ? Color.white : Color.clear);
                }
            tex.Apply();
            return tex;
        }

        static Texture2D MakeDot(int size)
        {
            var tex = new Texture2D(size, size, TextureFormat.RGBA32, false);
            float r = size / 2f;
            for (int y = 0; y < size; y++)
                for (int x = 0; x < size; x++)
                {
                    float d = Vector2.Distance(new Vector2(x + 0.5f, y + 0.5f), new Vector2(r, r));
                    tex.SetPixel(x, y, d <= r - 1 ? Color.white : d <= r ? new Color(0, 0, 0, 1) : Color.clear);
                }
            tex.Apply();
            return tex;
        }
    }

    // Keeps the game from reacting to keys typed into the search box or clicks on the window.
    static class InputGuard
    {
        [HarmonyPostfix, HarmonyPatch(typeof(UIUtils), nameof(UIUtils.AnyInputActive))]
        static void AnyInputActive(ref bool __result) { __result |= FinderPlugin.SearchFocused; }

        [HarmonyPostfix, HarmonyPatch(typeof(Utils), nameof(Utils.IsCursorOverUserInterface))]
        static void CursorOverUserInterface(ref bool __result) { __result |= FinderPlugin.CursorOverWindow; }
    }
}
