using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace WT2Gatherer
{
    // Trip to base when the inventory fills: walk to the claim (the server's "ClaimPointer" direction
    // point), open the player's own storage nearby (WTObject action "OpenContainer") and use the
    // inventory "Store" action (the same as clicking an item while a container is open) on every item
    // kind gathered this session, i.e. whose count grew since the bot started. Tries the next storage
    // when one fills up.
    internal class BaseUnloader
    {
        enum Phase { Idle, Travel, OpenNext, Opening, Storing, Settle }

        internal static BaseUnloader Active;   // receives the claim pointer from the Harmony hook

        static readonly FieldInfo WorldObjectsField =
            typeof(WTObject).GetField("worldObjects", BindingFlags.NonPublic | BindingFlags.Static);
        static readonly MethodInfo SetAgentDestination =
            typeof(WTPlayer).GetMethod("SetAgentDestination", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly MethodInfo CmdCloseContainer =
            typeof(Player).GetMethod("CmdCloseContainer", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly MethodInfo CmdGetDirectionPoints =
            typeof(Player).GetMethod("CmdGetDirectionPoints", BindingFlags.NonPublic | BindingFlags.Instance);

        readonly ConfigEntry<bool> enabled;
        readonly ConfigEntry<string> basePosition;
        readonly ConfigEntry<float> storageRadius;
        readonly ConfigEntry<string> keepItems;
        readonly Action<string> log;

        Phase phase = Phase.Idle;
        Dictionary<string, int> baseline = new Dictionary<string, int>();
        readonly HashSet<int> triedContainers = new HashSet<int>();
        readonly HashSet<string> notedTypes = new HashSet<string>();
        readonly HashSet<string> targetDrops = new HashSet<string>();   // items the target node kinds can yield
        readonly Queue<int> storeQueue = new Queue<int>();
        WTObject container;
        int containerTab;
        float phaseSince, nextAction, lastProgressAt;
        Vector3 lastPosition;
        int travelRetries;
        public string Status = "";
        public string Detail = "";
        public int Trips;

        public BaseUnloader(ConfigFile config, Action<string> log)
        {
            this.log = log;
            enabled = config.Bind("Base", "UnloadWhenFull", true,
                "When the inventory fills, walk to base, store gathered items in your storage there and come back.");
            basePosition = config.Bind("Base", "Position", "",
                "x,y,z of your base. Filled automatically from your land claim marker; edit to override.");
            storageRadius = config.Bind("Base", "StorageRadius", 40f, "Use your storages within this distance of the base position.");
            keepItems = config.Bind("Base", "KeepItems", "", "Comma-separated item ids never to store (e.g. food or bait you gather yourself). Everything else that the " +
                "target nodes drop, or that you gained since starting the bot, is stored.");
        }

        public bool Busy { get { return phase != Phase.Idle; } }
        public bool CanUnload { get { return enabled.Value && Base.HasValue; } }

        public Vector3? Base
        {
            get
            {
                var c = basePosition.Value.Split(',');
                float x, y, z;
                if (c.Length == 3 && float.TryParse(c[0], NumberStyles.Float, CultureInfo.InvariantCulture, out x)
                    && float.TryParse(c[1], NumberStyles.Float, CultureInfo.InvariantCulture, out y)
                    && float.TryParse(c[2], NumberStyles.Float, CultureInfo.InvariantCulture, out z))
                    return new Vector3(x, y, z);
                return null;
            }
        }

        public string Describe()
        {
            var b = Base;
            string where = b.HasValue ? string.Format("({0:0}, {1:0})", b.Value.x, b.Value.z) : "unknown (no claim marker yet)";
            return where + (enabled.Value ? "" : " [unload off]") + (Trips > 0 ? ", trips " + Trips : "") + (Busy ? " - " + Status : "");
        }

        internal void OnDirectionPoint(string type, Vector3 point)
        {
            if (type != "ClaimPointer") return;
            string value = string.Format(CultureInfo.InvariantCulture, "{0:0.0},{1:0.0},{2:0.0}", point.x, point.y, point.z);
            if (value == basePosition.Value) return;
            basePosition.Value = value;
            log("base position set from claim marker: " + value);
        }

        public static void RequestDirectionPoints(Player p)
        {
            if (p != null && CmdGetDirectionPoints != null) CmdGetDirectionPoints.Invoke(p, null);
        }

        // Remember inventory counts when the bot starts; later increases are what gets stored.
        public void SnapshotInventory(Player p)
        {
            baseline = Counts(p);
        }

        // Called for every target node the gatherer sees: remembers what that kind can drop.
        public void NoteTargetType(WTWorldType type)
        {
            if (type == null || !notedTypes.Add(type.name)) return;
            AddDrops(type.gatherSettings);
            if (type.states != null)
                foreach (var state in type.states)
                    if (state != null) AddDrops(state.stateGather);
        }

        void AddDrops(WTScriptableGather gather)
        {
            if (gather == null || gather.success == null) return;
            foreach (var g in gather.success)
                if (g.item != null) targetDrops.Add(g.item.name);
        }

        // False when nothing in the bags qualifies, so a trip would be pointless.
        public bool Begin(WTPlayer p)
        {
            if (GatheredSlots(p).Count == 0)
            {
                log("inventory full but nothing to store: no item kinds grew since the bot started and none are drops of " +
                    "the target nodes (known drops: " + string.Join(", ", targetDrops.OrderBy(x => x).ToArray()) + ")");
                return false;
            }
            triedContainers.Clear();
            travelRetries = 0;
            Enter(Phase.Travel, "walking to base");
            lastPosition = p.transform.position;
            lastProgressAt = Time.time;
            log("inventory full: unloading at base " + basePosition.Value + ", storing " + string.Join(", ", GatheredKinds(p).ToArray()));
            return true;
        }

        public void Abort()
        {
            if (phase == Phase.Idle) return;
            CloseContainer(Player.localPlayer);
            phase = Phase.Idle;
        }

        // Returns null while working, "" when done, or an error message.
        public string Tick(WTPlayer p)
        {
            var gm = GameManager.instance;
            switch (phase)
            {
                case Phase.Travel:
                {
                    Vector3 b = Base.Value;
                    float d = Vector3.Distance(p.transform.position, b);
                    if (d < 12f) { Enter(Phase.OpenNext, "looking for storage"); return null; }
                    Status = "walking to base";
                    Detail = " (" + d.ToString("0") + "m)";
                    if (Vector3.Distance(p.transform.position, lastPosition) > 2f) { lastPosition = p.transform.position; lastProgressAt = Time.time; }
                    if (Time.time - lastProgressAt > 20f)
                    {
                        if (++travelRetries > 3) return "can't reach base (stuck " + d.ToString("0") + "m away)";
                        lastProgressAt = Time.time;
                        log("stuck on the way to base, retrying");
                    }
                    if (!p.IsStateMovingOrRunning() && Time.time >= nextAction)
                    {
                        SetAgentDestination.Invoke(p, new object[] { b, 3f });
                        nextAction = Time.time + 2f;
                    }
                    return null;
                }
                case Phase.OpenNext:
                {
                    if (GatheredSlots(p).Count == 0) return "";
                    container = NextContainer(p);
                    if (container == null && triedContainers.Count == 0) LogNearbyStorage(p);
                    if (container == null)
                        return triedContainers.Count == 0 ? "no storage of yours within " + storageRadius.Value.ToString("0") + "m of base"
                                                          : "all storages near base are full";
                    triedContainers.Add(container.worldId);
                    var open = container.actionSkills.First(s => s != null && s.name == WTObject.OPEN_CONTAINER_SKILL_NAME);
                    p.WorldObjectTryAction(container, open);
                    Enter(Phase.Opening, "opening " + container.worldType.name);
                    return null;
                }
                case Phase.Opening:
                    if (gm != null && gm.IsContainerWindowOpen(out containerTab))
                    {
                        storeQueue.Clear();
                        foreach (int i in GatheredSlots(p)) storeQueue.Enqueue(i);
                        Enter(Phase.Storing, "storing " + storeQueue.Count + " stack(s) in " + container.worldType.name);
                        return null;
                    }
                    if (Time.time - phaseSince > 20f) { log("couldn't open " + container.worldType.name + ", trying another"); Enter(Phase.OpenNext, ""); }
                    return null;
                case Phase.Storing:
                    if (Time.time < nextAction) return null;
                    if (storeQueue.Count > 0)
                    {
                        int i = storeQueue.Dequeue();
                        p.CmdInventoryItemAction(i, ItemActionType.Store, containerTab);
                        nextAction = Time.time + 0.2f;
                        return null;
                    }
                    Enter(Phase.Settle, "checking what's left");
                    nextAction = Time.time + 1f;
                    return null;
                case Phase.Settle:
                    if (Time.time < nextAction) return null;
                    int left = GatheredSlots(p).Count;
                    CloseContainer(p);
                    if (left == 0)
                    {
                        Trips++;
                        log("unloaded into " + container.worldType.name);
                        return "";
                    }
                    log(container.worldType.name + " is full, " + left + " stack(s) left");
                    Enter(Phase.OpenNext, "");
                    return null;
            }
            return "";
        }

        public void Finish() { phase = Phase.Idle; Status = ""; }

        void Enter(Phase next, string status)
        {
            phase = next;
            Detail = "";
            phaseSince = Time.time;
            if (status.Length > 0) Status = status;
        }

        WTObject NextContainer(WTPlayer p)
        {
            var all = WorldObjectsField.GetValue(null) as Dictionary<int, WTObject>;
            if (all == null) return null;
            Vector3 b = Base.Value;
            return all.Values
                .Where(o => o != null && o.worldType != null && o.worldType.containerSlots > 0 && !triedContainers.Contains(o.worldId)
                            && Vector3.Distance(o.transform.position, b) <= storageRadius.Value
                            && o.actionSkills != null && o.actionSkills.Any(s => s != null && s.name == WTObject.OPEN_CONTAINER_SKILL_NAME)
                            && IsMine(o, p))
                .OrderBy(o => Vector3.Distance(o.transform.position, p.transform.position))
                .FirstOrDefault();
        }

        void LogNearbyStorage(WTPlayer p)
        {
            var all = WorldObjectsField.GetValue(null) as Dictionary<int, WTObject>;
            if (all == null) return;
            Vector3 b = Base.Value;
            var found = all.Values
                .Where(o => o != null && o.worldType != null && o.worldType.containerSlots > 0
                            && Vector3.Distance(o.transform.position, b) <= storageRadius.Value)
                .Select(o => string.Format("{0} owner {1}{2}", o.worldType.name, o.ownerId,
                    o.actionSkills != null && o.actionSkills.Any(s => s != null && s.name == WTObject.OPEN_CONTAINER_SKILL_NAME) ? "" : " (no OpenContainer)"))
                .ToArray();
            log("no usable storage: your worldId is " + p.worldId + "; containers near base: " + (found.Length == 0 ? "none" : string.Join(", ", found)));
        }

        // Client-safe part of WTObject.IsWrongOwner: own storage or a guild store while in a guild.
        // (IsWrongOwner itself ends in GameManager access lookups that only exist on the server and throw here.)
        static bool IsMine(WTObject o, Player p)
        {
            return o.ownerId == p.worldId || (o.IsGuildStore() && p.InGuild());
        }

        void CloseContainer(Player p)
        {
            if (p != null && CmdCloseContainer != null) CmdCloseContainer.Invoke(p, null);
        }

        static Dictionary<string, int> Counts(Player p)
        {
            var counts = new Dictionary<string, int>();
            foreach (var slot in p.inventory)
            {
                if (slot.amount <= 0) continue;
                int c;
                counts.TryGetValue(slot.item.name, out c);
                counts[slot.item.name] = c + slot.amount;
            }
            return counts;
        }

        // Item kinds to store: anything that grew since the bot started, plus anything the target nodes drop.
        List<string> GatheredKinds(Player p)
        {
            var keep = new HashSet<string>(keepItems.Value.Split(',').Select(s => s.Trim()), StringComparer.OrdinalIgnoreCase);
            return Counts(p).Where(kv =>
            {
                int before;
                baseline.TryGetValue(kv.Key, out before);
                return (kv.Value > before || targetDrops.Contains(kv.Key)) && !keep.Contains(kv.Key);
            }).Select(kv => kv.Key).OrderBy(s => s).ToList();
        }

        List<int> GatheredSlots(Player p)
        {
            var kinds = new HashSet<string>(GatheredKinds(p));
            var slots = new List<int>();
            for (int i = 0; i < p.inventory.Count; i++)
                if (p.inventory[i].amount > 0 && kinds.Contains(p.inventory[i].item.name)) slots.Add(i);
            return slots;
        }
    }

    static class BaseHooks
    {
        [HarmonyPostfix, HarmonyPatch(typeof(Player), nameof(Player.UserCode_TargetSetDirectionPoint))]
        static void Set(string type, Vector3 point)
        {
            if (BaseUnloader.Active != null) BaseUnloader.Active.OnDirectionPoint(type, point);
        }
    }
}
