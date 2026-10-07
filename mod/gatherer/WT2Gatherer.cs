using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using BepInEx;
using BepInEx.Configuration;
using HarmonyLib;
using UnityEngine;

namespace WT2Gatherer
{
    // Gathering automation for private sandboxes: walks to the nearest node of the chosen
    // world types and triggers the same action the in-game "gather" prompt does
    // (WTPlayer.WorldObjectTryAction). Pathing to the node is left to the game itself.
    // Note: never name a method Start/Update/etc. with parameters - Unity treats those names
    // as messages and rejects the whole script ("Start() can not take parameters").
    [BepInPlugin("skpd.wt2.gatherer", "WT2 Gatherer", "0.2.0")]
    public class GathererPlugin : BaseUnityPlugin
    {
        const float Tick = 0.25f;
        const string FinderTrackedKey = "skpd.wt2.finder.tracked";   // published by WT2Finder

        static readonly FieldInfo WorldObjectsField =
            typeof(WTObject).GetField("worldObjects", BindingFlags.NonPublic | BindingFlags.Static);
        static readonly MethodInfo SetAgentDestination =
            typeof(WTPlayer).GetMethod("SetAgentDestination", BindingFlags.NonPublic | BindingFlags.Instance);

        ConfigEntry<string> targets;
        ConfigEntry<bool> useFinderSelection;
        ConfigEntry<string> waypoints;
        ConfigEntry<float> scanRadius;
        ConfigEntry<float> nodeTimeout;
        ConfigEntry<float> minHealthPercent;
        ConfigEntry<float> minStaminaPercent;
        ConfigEntry<int> minFreeSlots;
        ConfigEntry<bool> stopOnDamage;
        ConfigEntry<bool> pauseOnManualInput;
        ConfigEntry<bool> verbose;
        ConfigEntry<KeyboardShortcut> toggleKey, pickTargetKey, addWaypointKey, clearWaypointsKey;

        bool running;
        string status = "off (F8 to start)";
        string lastTraced;
        WTObject current;
        float progressAt;   // last time the current node made progress (moving to it or gathering)
        int lastHealth;
        int actions;
        int routeIndex;
        float nextTick;
        readonly Dictionary<int, float> blacklist = new Dictionary<int, float>();   // worldId -> until
        readonly List<Vector3> route = new List<Vector3>();
        FishingAssist fishing;
        ExploreArea explore;
        BaseUnloader unloader;
        Eater eater;
        Harmony harmony;
        float nextFishingCheck;
        Vector3 patrolPosition;
        float patrolProgressAt, lastPatrolAt;
        Vector3? patrolTarget;

        // diagnostics
        int updates, guis;
        bool hadPlayer;
        readonly HashSet<string> reportedErrors = new HashSet<string>();

        void Awake()
        {
            targets = Config.Bind("Gathering", "Targets", "",
                "Extra comma-separated world types to gather besides the ones ticked in the finder window " +
                "(ids as in gathers.json, e.g. IronDeposit,IronDepositLarge). A trailing * matches by prefix (IronDeposit*). " +
                "F7 sets it from the node you last interacted with.");
            useFinderSelection = Config.Bind("Gathering", "UseFinderSelection", true,
                "Also gather every resource kind ticked in the finder window (F6).");
            scanRadius = Config.Bind("Gathering", "ScanRadius", 60f, "Ignore nodes farther than this (meters).");
            nodeTimeout = Config.Bind("Gathering", "NodeTimeout", 25f,
                "Seconds without progress before a node is skipped for 2 minutes (unreachable, no tool, skill too low).");
            waypoints = Config.Bind("Route", "Waypoints", "",
                "Patrol route used when no target is in range: x,y,z;x,y,z. F9 adds your position, F10 clears.");
            minHealthPercent = Config.Bind("Safety", "MinHealthPercent", 60f, "Stop below this health percentage.");
            minStaminaPercent = Config.Bind("Safety", "MinStaminaPercent", 10f, "Wait (not stop) below this stamina percentage.");
            minFreeSlots = Config.Bind("Safety", "MinFreeInventorySlots", 1, "Stop when fewer free inventory slots remain.");
            stopOnDamage = Config.Bind("Safety", "StopOnDamage", true, "Stop as soon as health drops.");
            pauseOnManualInput = Config.Bind("Safety", "PauseOnManualInput", true, "Pause when you click or press WASD.");
            verbose = Config.Bind("Debug", "Verbose", true, "Log lifecycle, key presses and every decision change; show tick counters.");
            toggleKey = Config.Bind("Keys", "Toggle", new KeyboardShortcut(KeyCode.F8));
            pickTargetKey = Config.Bind("Keys", "PickTarget", new KeyboardShortcut(KeyCode.F7));
            addWaypointKey = Config.Bind("Keys", "AddWaypoint", new KeyboardShortcut(KeyCode.F9));
            clearWaypointsKey = Config.Bind("Keys", "ClearWaypoints", new KeyboardShortcut(KeyCode.F10));
            LoadRoute();
            fishing = new FishingAssist(Logger, Config);
            FishingAssist.Active = fishing;
            explore = new ExploreArea(Config, Trace);
            unloader = new BaseUnloader(Config, message => Logger.LogInfo(message));
            eater = new Eater(Config, message => Logger.LogInfo(message));
            BaseUnloader.Active = unloader;
            harmony = new Harmony("skpd.wt2.gatherer");
            try
            {
                harmony.PatchAll(typeof(FishingHooks));
                harmony.PatchAll(typeof(BaseHooks));
            }
            catch (Exception e) { Report("Harmony patching", e); }
            Trace("fishing hooks: " + harmony.GetPatchedMethods().Count() + " patched method(s)");
            Logger.LogInfo(string.Format("awake: worldObjects field {0}, SetAgentDestination {1}, {2} waypoint(s), targets '{3}'",
                WorldObjectsField != null ? "ok" : "MISSING", SetAgentDestination != null ? "ok" : "MISSING",
                route.Count, targets.Value));
        }

        void OnDestroy()
        {
            // Undo patches so ScriptEngine reloads don't stack them.
            if (harmony != null) harmony.UnpatchSelf();
            if (FishingAssist.Active == fishing) FishingAssist.Active = null;
            if (BaseUnloader.Active == unloader) BaseUnloader.Active = null;
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
            var player = Player.localPlayer as WTPlayer;
            TrackPlayer();
            if (WorldObjectsField == null || SetAgentDestination == null) return;

            if (toggleKey.Value.IsDown())
            {
                bool pole = FishingAssist.PoleEquipped(player);
                Trace("toggle key pressed" + (pole ? " with a fishing pole" : ""));
                if (pole && !running) fishing.Toggle(player);
                else if (running) StopBot("stopped by user");
                else StartBot(player);
            }
            if (player != null) TickFishing(player);
            if (pickTargetKey.Value.IsDown()) { Trace("pick-target key pressed"); if (player != null) PickTarget(player); }
            if (addWaypointKey.Value.IsDown()) { Trace("add-waypoint key pressed"); if (player != null) AddWaypoint(player.transform.position); }
            if (clearWaypointsKey.Value.IsDown()) { Trace("clear-waypoints key pressed"); route.Clear(); routeIndex = 0; SaveRoute(); }

            if (!running) return;
            if (pauseOnManualInput.Value && ManualInput()) { StopBot("paused: manual input"); return; }
            if (Time.time < nextTick) return;
            nextTick = Time.time + Tick;
            if (player == null) { StopBot("no local player"); return; }
            Step(player);
        }

        void StartBot(WTPlayer player)
        {
            if (player == null) { SetStatus("no local player (Player.localPlayer is null or not a WTPlayer)"); return; }
            if (TargetSet().Count == 0) { SetStatus("no targets: tick resources in the F6 window (or F7)"); return; }
            running = true;
            current = null;
            lastHealth = player.health;
            unloader.SnapshotInventory(player);
            SetStatus("started, targets: " + TargetsText());
        }

        void StopBot(string reason)
        {
            running = false;
            current = null;
            unloader.Abort();
            unloader.Finish();
            SetStatus(reason);
        }

        void Step(WTPlayer p)
        {
            string reason = StopReason(p, false);
            if (reason != null) { StopBot(reason); return; }

            if (unloader.Busy)
            {
                string result = unloader.Tick(p);
                if (result == null) { SetStatus("unloading: " + unloader.Status, unloader.Detail); return; }
                unloader.Finish();
                if (result.Length > 0) { StopBot("stopped: " + result); return; }
                current = null;
                SetStatus("unloaded, back to work");
                return;
            }

            if (p.IsStateCasting() || p.IsStateCraftingOrRepairing())
            {
                progressAt = Time.time;
                SetStatus("gathering " + Describe(current));
                return;
            }

            if (eater.Tick(p))
            {
                progressAt = Time.time;
                SetStatus("eating");
                return;
            }

            if (p.InventorySlotsFree() < minFreeSlots.Value)
            {
                if (!unloader.CanUnload) { StopBot("stopped: inventory full" + (unloader.Base.HasValue ? "" : " (base unknown)")); return; }
                current = null;
                string ignored;
                FindNearest(p, out ignored);   // lets the unloader learn the drops of target nodes in view
                if (!unloader.Begin(p)) StopBot("stopped: inventory full, nothing to store (see log)");
                return;
            }

            if (p.staminaMax > 0 && 100f * p.stamina / p.staminaMax < minStaminaPercent.Value)
            {
                progressAt = Time.time;
                SetStatus("waiting for stamina");
                return;
            }

            if (current != null && Time.time - progressAt > nodeTimeout.Value)
            {
                Logger.LogWarning("no progress on " + Describe(current) + " (state " + p.state + "), skipping it for 2 minutes");
                blacklist[current.worldId] = Time.time + 120f;
                current = null;
            }

            if (p.IsStateMovingOrRunning() && current != null)
            {
                SetStatus("walking to " + Describe(current), " (" + Distance(p, current).ToString("0") + "m)");
                return;
            }

            string why;
            WTObject node = FindNearest(p, out why);
            if (node != null)
            {
                ScriptableSkill skill = node.actionSkills == null ? null
                    : node.actionSkills.FirstOrDefault(s => s != null && node.IsGatherSkill(s));
                if (skill == null)
                {
                    Trace("no gather skill on " + Describe(node) + ", actions: " +
                          (node.actionSkills == null ? "none" : string.Join(",", node.actionSkills.Where(s => s != null).Select(s => s.name).ToArray())));
                    blacklist[node.worldId] = Time.time + 120f;
                    return;
                }
                if (node != current) { current = node; progressAt = Time.time; }
                p.WorldObjectTryAction(node, skill);
                actions++;
                SetStatus("gather " + Describe(node) + " via " + skill.name + ", player state " + p.state);
                return;
            }

            current = null;
            Patrol(p, why);
        }

        void TickFishing(WTPlayer p)
        {
            fishing.Tick(p);
            if (!fishing.Enabled) return;
            if (!p.IsFishing() && eater.Tick(p)) fishing.Status = "eating";
            if (pauseOnManualInput.Value && (Input.GetKeyDown(KeyCode.W) || Input.GetKeyDown(KeyCode.A)
                || Input.GetKeyDown(KeyCode.S) || Input.GetKeyDown(KeyCode.D)))
            {
                fishing.Disable("fishing paused: manual input");
                return;
            }
            if (Time.time < nextFishingCheck) return;
            nextFishingCheck = Time.time + Tick;
            string reason = StopReason(p, true);
            if (reason != null) fishing.Disable("fishing " + reason);
            else if (!FishingAssist.PoleEquipped(p)) fishing.Disable("fishing stopped: pole unequipped");
        }

        // Also records the current health so the next call can detect damage.
        string StopReason(WTPlayer p, bool checkInventory)
        {
            int previous = lastHealth;
            lastHealth = p.health;
            if (p.IsStateDead() || p.IsStateFaint()) return "stopped: dead or fainted";
            if (p.healthMax > 0 && 100f * p.health / p.healthMax < minHealthPercent.Value) return "stopped: low health";
            if (stopOnDamage.Value && p.health < previous) return "stopped: taking damage";
            if (checkInventory && p.InventorySlotsFree() < minFreeSlots.Value) return "stopped: inventory full";
            return null;
        }

        static bool ManualInput()
        {
            return Input.GetMouseButtonDown(0) || Input.GetMouseButtonDown(1)
                || Input.GetKeyDown(KeyCode.W) || Input.GetKeyDown(KeyCode.A)
                || Input.GetKeyDown(KeyCode.S) || Input.GetKeyDown(KeyCode.D);
        }

        // Returns the nearest eligible node; otherwise explains why none qualified.
        WTObject FindNearest(WTPlayer p, out string why)
        {
            var all = WorldObjectsField.GetValue(null) as Dictionary<int, WTObject>;
            if (all == null) { why = "worldObjects registry is null"; return null; }
            var wanted = TargetSet();
            int typed = 0, matching = 0, tooFar = 0, skipped = 0;
            WTObject best = null;
            float bestDist = scanRadius.Value;
            foreach (var o in all.Values)
            {
                if (o == null || o.worldType == null) continue;
                typed++;
                if (!Matches(wanted, o.worldType.name)) continue;
                matching++;
                unloader.NoteTargetType(o.worldType);
                float until;
                if (blacklist.TryGetValue(o.worldId, out until) && until > Time.time) { skipped++; continue; }
                float d = Distance(p, o);
                if (d >= bestDist) { tooFar++; continue; }
                bestDist = d; best = o;
            }
            why = string.Format("{0} known objects, {1} of target type, {2} beyond {3:0}m, {4} skipped",
                typed, matching, tooFar, scanRadius.Value, skipped);
            return best;
        }

        // Walks the explore sweep when an area is set, otherwise the F9 waypoints.
        void Patrol(WTPlayer p, string why)
        {
            bool exploring = explore.Active;
            List<Vector3> path = exploring ? explore.Sweep(p.transform.position) : route;
            if (path.Count == 0)
            {
                patrolTarget = null;
                SetStatus(exploring ? "explore area has no walkable waypoints" : "no targets in range (draw an area on the map or add waypoints with F9)", ": " + why);
                return;
            }
            Vector3 pos = p.transform.position;
            if (Time.time - lastPatrolAt > 2f) { patrolPosition = pos; patrolProgressAt = Time.time; }   // resumed after gathering
            lastPatrolAt = Time.time;
            if (Vector3.Distance(pos, patrolPosition) > 2f) { patrolPosition = pos; patrolProgressAt = Time.time; }

            Vector3 dest = path[routeIndex % path.Count];
            bool reached = Vector3.Distance(pos, dest) < (exploring ? 8f : 4f);
            bool stuck = Time.time - patrolProgressAt > 15f;
            if (reached || stuck)
            {
                if (stuck) Logger.LogWarning("no progress towards waypoint " + (routeIndex % path.Count + 1) + ", skipping it");
                routeIndex = (routeIndex + 1) % path.Count;
                dest = path[routeIndex];
                patrolProgressAt = Time.time;
            }
            patrolTarget = dest;
            if (!p.IsStateMovingOrRunning())
                SetAgentDestination.Invoke(p, new object[] { dest, 1f });
            SetStatus((exploring ? "exploring, waypoint " : "patrolling to waypoint ") + (routeIndex % path.Count + 1) + "/" + path.Count, ": " + why);
        }

        void PickTarget(WTPlayer p)
        {
            WTObject o = p.objectTarget;
            if (o == null || o.worldType == null) { SetStatus("F7: interact with a node first (no objectTarget)"); return; }
            targets.Value = o.worldType.name;
            SetStatus("target set to " + o.worldType.name);
        }

        // Resources ticked in the finder window (F6) plus the Targets setting; finder mobs are ignored.
        HashSet<string> TargetSet()
        {
            var set = new HashSet<string>(
                targets.Value.Split(',').Select(s => s.Trim()).Where(s => s.Length > 0),
                StringComparer.OrdinalIgnoreCase);
            var finder = useFinderSelection.Value ? AppDomain.CurrentDomain.GetData(FinderTrackedKey) as string : null;
            if (!string.IsNullOrEmpty(finder))
                foreach (var key in finder.Split(','))
                    if (key.StartsWith("obj:")) set.Add(key.Substring(4));
            return set;
        }

        string TargetsText()
        {
            var set = TargetSet();
            return set.Count == 0 ? "- (tick resources in F6)" : string.Join(", ", set.OrderBy(s => s).ToArray());
        }

        static bool Matches(HashSet<string> wanted, string name)
        {
            if (wanted.Contains(name)) return true;
            foreach (var w in wanted)
                if (w.EndsWith("*") && name.StartsWith(w.Substring(0, w.Length - 1), StringComparison.OrdinalIgnoreCase))
                    return true;
            return false;
        }

        static float Distance(WTPlayer p, WTObject o)
        {
            return Vector3.Distance(p.transform.position, o.transform.position);
        }

        static string Describe(WTObject o)
        {
            return o == null || o.worldType == null ? "?" : o.worldType.name;
        }

        void AddWaypoint(Vector3 pos)
        {
            route.Add(pos);
            SaveRoute();
            SetStatus("waypoint " + route.Count + " added");
        }

        void LoadRoute()
        {
            route.Clear();
            foreach (var part in waypoints.Value.Split(new[] { ';' }, StringSplitOptions.RemoveEmptyEntries))
            {
                var c = part.Split(',');
                if (c.Length != 3) continue;
                route.Add(new Vector3(
                    float.Parse(c[0], CultureInfo.InvariantCulture),
                    float.Parse(c[1], CultureInfo.InvariantCulture),
                    float.Parse(c[2], CultureInfo.InvariantCulture)));
            }
        }

        void SaveRoute()
        {
            waypoints.Value = string.Join(";", route.Select(v => string.Format(CultureInfo.InvariantCulture,
                "{0:0.0},{1:0.0},{2:0.0}", v.x, v.y, v.z)).ToArray());
        }

        // The stable part is logged on change; the volatile detail (distances, counts) only shows on screen.
        void SetStatus(string stable, string detail = "")
        {
            status = stable + detail;
            if (stable != lastTraced)
            {
                lastTraced = stable;
                Trace("status: " + stable + detail);
            }
        }

        void TrackPlayer()
        {
            bool has = Player.localPlayer != null;
            if (has == hadPlayer) return;
            hadPlayer = has;
            Trace(has ? "local player found: " + Player.localPlayer.GetType().Name + " at " + Player.localPlayer.transform.position
                      : "local player lost");
            if (has && !unloader.Base.HasValue) BaseUnloader.RequestDirectionPoints(Player.localPlayer);
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

        void OnGUI()
        {
            if (++guis == 1) Trace("first OnGUI call");
            try
            {
                if (Player.localPlayer != null) explore.OnMapGUI(running ? patrolTarget : null);
                GUILayout.BeginArea(new Rect(10, 140, 420, 210), GUI.skin.box);
                GUILayout.Label("Gatherer: " + (running ? "ON" : "off") + "  [F8 toggle, F7 pick, F9/F10 route]");
                GUILayout.Label("Targets: " + TargetsText());
                GUILayout.Label("Status: " + status);
                GUILayout.Label("Actions: " + actions + "   F9 waypoints: " + route.Count);
                GUILayout.Label("Explore: " + explore.Describe());
                GUILayout.Label("Base: " + unloader.Describe());
                if (Player.localPlayer != null && Player.localPlayer.food != null)
                    GUILayout.Label("Food: " + string.Join("/", Player.localPlayer.food.Select(v => v.ToString()).ToArray()) +
                                    (Eater.IsHungry(Player.localPlayer) ? "  HUNGRY" : "") + (eater.Eaten > 0 ? "  (ate " + eater.Eaten + ")" : ""));
                GUILayout.Label("Fishing: " + fishing.Summary());
                if (verbose.Value)
                    GUILayout.Label(string.Format("debug: updates {0}, gui {1}, player {2}", updates, guis,
                        Player.localPlayer == null ? "none" : Player.localPlayer.GetType().Name + " " + Player.localPlayer.state));
                GUILayout.EndArea();
            }
            catch (Exception e) { Report("OnGUI", e); }
        }
    }
}
