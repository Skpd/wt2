using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using BepInEx.Configuration;
using BepInEx.Logging;
using HarmonyLib;
using UnityEngine;

namespace WT2Gatherer
{
    // One fish's bite sequence (generated into FishData.cs from the game's WTFish data).
    internal class FishDef
    {
        public readonly string Id;
        public readonly string[] Names;
        readonly byte[] steps;   // 4 bytes per step: FishBite, useToCatch, useToStayHooked, hookedAfterBite

        public FishDef(string id, string[] names, byte[] steps)
        {
            Id = id;
            Names = names;
            this.steps = steps;
        }

        public int Count { get { return steps.Length / 4; } }
        public FishBite Bite(int i) { return (FishBite)steps[i * 4]; }
        public FishingUse Catch(int i) { return (FishingUse)steps[i * 4 + 1]; }
        public FishingUse Stay(int i) { return (FishingUse)steps[i * 4 + 2]; }
        public bool IsGarbage { get { return Id.Contains("Garbage"); } }

        // Index of the bite after which the fish is hooked; -1 if it never gets hooked.
        public int HookIndex
        {
            get
            {
                for (int i = 0; i < Count; i++) if (steps[i * 4 + 3] != 0) return i;
                return -1;
            }
        }
    }

    // Fishing minigame helper. Each fish is a fixed bite sequence. Rules inferred from server feedback
    // (the server code isn't in the client):
    //  - any press up to and including the hooking bite fails ("Failed.BeforeHook") -> wait;
    //  - once hooked every bite needs a press: useToCatch if it is a button, else useToStayHooked;
    //    Any = any button, None = don't press (doing nothing otherwise fails with "HookedError").
    // The server's tip turned out not to be the answer for the current bite, so it's only logged.
    // Candidates are the fish the server lists for this water (TargetShowFishingActions info[0])
    // plus garbage, narrowed by the bites seen so far; the answer is a weighted vote.
    internal class FishingAssist
    {
        enum Move { Wait, DragOut, Pull, Strike, AnyPress }

        // Set while the plugin is alive; the Harmony hooks forward the fishing RPCs here.
        internal static FishingAssist Active;

        static readonly MethodInfo IsFishingPoleEquipped =
            typeof(WTPlayer).GetMethod("IsFishingPoleEquipped", BindingFlags.NonPublic | BindingFlags.Instance);

        readonly ManualLogSource log;
        readonly ConfigEntry<bool> autoRespond, autoRecast, catchAtLastBite;
        readonly ConfigEntry<float> reactionDelay, recastDelay;

        public bool Enabled;
        public string Status = "idle";
        int catches, misses;

        List<KeyValuePair<FishDef, float>> pool = new List<KeyValuePair<FishDef, float>>();
        readonly List<FishBite> bites = new List<FishBite>();
        bool inSession;
        bool caughtThisSession;
        FishingUse? pending;
        float respondAt;
        float recastAt = -1f;
        float castIssuedAt = -1f;
        int failedCasts;

        public FishingAssist(ManualLogSource log, ConfigFile config)
        {
            this.log = log;
            autoRespond = config.Bind("Fishing", "AutoRespond", true,
                "When the helper is on (F8 with a fishing pole equipped), answer bites automatically. Off = hints only.");
            reactionDelay = config.Bind("Fishing", "ReactionDelay", 0.4f, "Seconds between a bite and the answer.");
            autoRecast = config.Bind("Fishing", "AutoRecast", true, "Cast again after each catch or miss.");
            recastDelay = config.Bind("Fishing", "RecastDelay", 2.5f, "Seconds to wait before casting again.");
            catchAtLastBite = config.Bind("Fishing", "CatchAtLastBite", false,
                "Experiment: when a bite allows catching but the fish can also be kept hooked, keep it hooked and " +
                "catch on its last bite instead (compare catch rates with this on/off).");
        }

        public static bool PoleEquipped(WTPlayer p)
        {
            return p != null && IsFishingPoleEquipped != null && (bool)IsFishingPoleEquipped.Invoke(p, null);
        }

        public void Toggle(WTPlayer p)
        {
            if (Enabled) { Disable("fishing helper off"); return; }
            Enabled = true;
            failedCasts = 0;
            pending = null;
            recastAt = autoRecast.Value && !p.IsFishing() ? Time.time : -1f;
            Status = "on" + (autoRecast.Value ? ", casting" : ", cast to start");
            log.LogInfo("fishing helper on (auto respond " + autoRespond.Value + ", auto recast " + autoRecast.Value + ")");
        }

        public void Disable(string reason)
        {
            if (!Enabled) return;
            Enabled = false;
            pending = null;
            recastAt = -1f;
            Status = reason;
            log.LogInfo(reason);
        }

        public string Summary()
        {
            return (Enabled ? "ON" : "off") + " - " + Status + "  (caught " + catches + ", lost " + misses + ")";
        }

        // ---- RPC hooks ---------------------------------------------------------------------------

        public void OnStart(string[] info)
        {
            inSession = true;
            caughtThisSession = false;
            castIssuedAt = -1f;
            failedCasts = 0;
            bites.Clear();
            pending = null;
            pool = BuildPool(info);
            Status = "waiting for a bite (" + pool.Count(c => !c.Key.IsGarbage) + " fish possible)";
            log.LogInfo("fishing started, info [" + string.Join(" | ", info ?? new string[0]) + "], candidates: " +
                        string.Join(", ", pool.Select(c => c.Key.Id).ToArray()));
        }

        public void OnBite(FishBite bite, FishingUse tip, bool success)
        {
            bites.Add(bite);
            string why;
            FishingUse answer = Decide(out why);
            // With success=true the tip always matched the right answer (None = wait); with false it was misleading.
            // CatchAtLastBite deliberately ignores "catch now" tips, so the tip only fills in when we'd wait.
            if (success && tip != FishingUse.Any && !(catchAtLastBite.Value && answer != FishingUse.None))
            {
                if (tip != answer) why = "server tip overrides " + (answer == FishingUse.None ? "wait" : answer.ToString()) + "; " + why;
                else why = "server tip agrees; " + why;
                answer = tip;
            }
            Status = "bite #" + bites.Count + " " + bite + " -> " + (answer == FishingUse.None ? "wait" : answer.ToString()) + " (" + why + ")";
            log.LogInfo(Status + "; server tip " + tip + ", success flag " + success);
            if (Enabled && autoRespond.Value && answer != FishingUse.None)
            {
                pending = answer;
                respondAt = Time.time + reactionDelay.Value;
            }
        }

        public void OnPlayerAction(FishingUse action, bool fail, string message)
        {
            log.LogInfo("answer " + action + (fail ? " failed" : " ok") + (string.IsNullOrEmpty(message) ? "" : ": " + message));
        }

        public void OnResult(Item item)
        {
            caughtThisSession = true;
            catches++;
            Status = "caught " + item.name;
            log.LogInfo("caught " + item.name + " after " + bites.Count + " bite(s): " + BiteList());
        }

        public void OnEnd()
        {
            if (!inSession) return;
            inSession = false;
            pending = null;
            if (!caughtThisSession)
            {
                misses++;
                Status = "fish lost after " + bites.Count + " bite(s)";
                log.LogInfo(Status + ": " + BiteList());
            }
            if (Enabled && autoRecast.Value) recastAt = Time.time + recastDelay.Value;
        }

        // ---- per-frame -------------------------------------------------------------------------

        public void Tick(WTPlayer p)
        {
            if (pending.HasValue && Time.time >= respondAt)
            {
                if (p.IsFishing())
                {
                    p.CmdFishingUse(pending.Value);
                    log.LogInfo("answered " + pending.Value);
                }
                pending = null;
            }
            if (!Enabled) return;

            if (castIssuedAt > 0 && !inSession && Time.time - castIssuedAt > 15f)
            {
                castIssuedAt = -1f;
                if (++failedCasts >= 3) { Disable("stopped: casting keeps failing (no water in front, no bait?)"); return; }
                recastAt = Time.time;
            }

            if (recastAt >= 0 && Time.time >= recastAt && !inSession && !p.IsFishing() && p.IsStateIdle())
            {
                recastAt = -1f;
                int skill = p.FindSkillIndexForWeapon();
                if (skill < 0) { Disable("stopped: no fishing skill for the equipped pole"); return; }
                p.TryUseSkill(skill);
                castIssuedAt = Time.time;
                Status = "casting";
                log.LogInfo("cast (skill index " + skill + ")");
            }
        }

        // ---- decision --------------------------------------------------------------------------

        FishingUse Decide(out string why)
        {
            int step = bites.Count - 1;
            var score = new Dictionary<Move, float> { { Move.Wait, 0 }, { Move.DragOut, 0 }, { Move.Pull, 0 }, { Move.Strike, 0 } };
            var detail = new List<string>();
            float total = 0;
            foreach (var c in pool)
            {
                FishDef f = c.Key;
                if (f.Count <= step) continue;
                bool matches = true;
                for (int i = 0; i <= step && matches; i++) matches = f.Bite(i) == bites[i];
                if (!matches) continue;
                Move m = MoveFor(f, step, catchAtLastBite.Value);
                if (m == Move.AnyPress)
                {
                    score[Move.DragOut] += c.Value;
                    score[Move.Pull] += c.Value;
                    score[Move.Strike] += c.Value;
                }
                else score[m] += c.Value;
                total += c.Value;
                detail.Add(f.Id + ":" + m);
            }
            if (total == 0) { why = "no known fish matches"; return FishingUse.None; }
            // Ties: Pull is the press observed to be safe on "any button" bites; waiting comes last.
            var best = score.OrderByDescending(kv => kv.Value).ThenBy(kv => TieRank(kv.Key)).First();
            why = string.Format("{0:P0} agree; {1}", Math.Min(1f, best.Value / total), string.Join(", ", detail.ToArray()));
            switch (best.Key)
            {
                case Move.DragOut: return FishingUse.DragOut;
                case Move.Pull: return FishingUse.Pull;
                case Move.Strike: return FishingUse.Strike;
                default: return FishingUse.None;
            }
        }

        static int TieRank(Move m)
        {
            switch (m)
            {
                case Move.Pull: return 0;
                case Move.Strike: return 1;
                case Move.DragOut: return 2;
                default: return 3;
            }
        }

        static Move MoveFor(FishDef f, int step, bool catchAtLastBite)
        {
            int hook = f.HookIndex;
            if (hook < 0 || step <= hook) return Move.Wait;
            Move m;
            bool last = step == f.Count - 1;
            if (catchAtLastBite && !last && TryPress(f.Stay(step), out m)) return m;
            if (TryPress(f.Catch(step), out m)) return m;
            if (TryPress(f.Stay(step), out m)) return m;
            return Move.Wait;
        }

        static bool TryPress(FishingUse use, out Move move)
        {
            switch (use)
            {
                case FishingUse.DragOut: move = Move.DragOut; return true;
                case FishingUse.Pull: move = Move.Pull; return true;
                case FishingUse.Strike: move = Move.Strike; return true;
                case FishingUse.Any: move = Move.AnyPress; return true;
                default: move = Move.Wait; return false;
            }
        }

        // Fish listed by the server for this water (localized names, comma-separated in info[0]) plus
        // garbage, which is never listed. Garbage types share one sequence, so they split one vote.
        List<KeyValuePair<FishDef, float>> BuildPool(string[] info)
        {
            var listed = new HashSet<string>(
                (info != null && info.Length > 0 ? info[0] : "").Split(',').Select(Normalize).Where(s => s.Length > 0));
            var matched = FishData.All.Where(f => !f.IsGarbage && f.Names.Any(n => listed.Contains(Normalize(n)))).ToList();
            var unmatched = listed.Where(n => !matched.Any(f => f.Names.Any(x => Normalize(x) == n))).ToList();
            if (unmatched.Count > 0) log.LogWarning("fish names not in FishData (regenerate it?): " + string.Join(", ", unmatched.ToArray()));
            if (matched.Count == 0)
                return FishData.All.Select(f => new KeyValuePair<FishDef, float>(f, 1f)).ToList();
            var garbage = FishData.All.Where(f => f.IsGarbage).ToList();
            return matched.Select(f => new KeyValuePair<FishDef, float>(f, 1f))
                .Concat(garbage.Select(f => new KeyValuePair<FishDef, float>(f, 1f / garbage.Count))).ToList();
        }

        static string Normalize(string s)
        {
            return new string(s.Where(char.IsLetterOrDigit).ToArray()).ToLowerInvariant();
        }

        string BiteList()
        {
            return string.Join(",", bites.Select(b => b.ToString()).ToArray());
        }
    }

    // Client-side handlers of the fishing target RPCs; they only run for the local player.
    static class FishingHooks
    {
        [HarmonyPostfix, HarmonyPatch(typeof(WTPlayer), nameof(WTPlayer.UserCode_TargetShowFishingActions))]
        static void Show(string[] fishingAreaInfo)
        {
            if (FishingAssist.Active != null) FishingAssist.Active.OnStart(fishingAreaInfo);
        }

        [HarmonyPostfix, HarmonyPatch(typeof(WTPlayer), nameof(WTPlayer.UserCode_TargetAddFishAction))]
        static void Bite(FishBite action, FishingUse tipFishingUse, bool success)
        {
            if (FishingAssist.Active != null) FishingAssist.Active.OnBite(action, tipFishingUse, success);
        }

        [HarmonyPostfix, HarmonyPatch(typeof(WTPlayer), nameof(WTPlayer.UserCode_TargetAddPlayerAction))]
        static void PlayerAction(FishingUse action, bool fishingFail, string failMessage)
        {
            if (FishingAssist.Active != null) FishingAssist.Active.OnPlayerAction(action, fishingFail, failMessage);
        }

        [HarmonyPostfix, HarmonyPatch(typeof(WTPlayer), nameof(WTPlayer.UserCode_TargetAddFishingResult))]
        static void Result(Item item)
        {
            if (FishingAssist.Active != null) FishingAssist.Active.OnResult(item);
        }

        [HarmonyPostfix, HarmonyPatch(typeof(WTPlayer), nameof(WTPlayer.UserCode_TargetHideFishingActions))]
        static void Hide()
        {
            if (FishingAssist.Active != null) FishingAssist.Active.OnEnd();
        }
    }
}
