using System;
using System.Collections.Generic;
using System.Linq;
using System.Reflection;
using HarmonyLib;
using UnityEngine;

namespace WT2Finder
{
    // Direction points the server sends to the local player (Player.TargetSetDirectionPoint): quest
    // targets and, presumably, the results of "Potion of searching for X". The game shows them as
    // pointers; we mirror them so the finder can list them with distances and draw markers.
    internal static class ServerMarkers
    {
        internal class Point
        {
            public string Type, Name;
            public Vector3 Position;
            public float ReceivedAt;
            public string Label { get { return string.IsNullOrEmpty(Type) ? Name : Type + ": " + Name; } }
        }

        internal static readonly Dictionary<string, Point> Points = new Dictionary<string, Point>();
        internal static Action<string> Log = delegate { };

        static readonly MethodInfo CmdGetDirectionPoints =
            typeof(Player).GetMethod("CmdGetDirectionPoints", BindingFlags.NonPublic | BindingFlags.Instance);

        static string Key(string type, string name) { return type + "/" + name; }

        // Asks the server to resend every active point (the game does this once on login).
        internal static bool RequestAll(Player player)
        {
            if (player == null || CmdGetDirectionPoints == null) return false;
            CmdGetDirectionPoints.Invoke(player, null);
            return true;
        }

        internal static void Set(string type, string name, Vector3 point)
        {
            Points[Key(type, name)] = new Point { Type = type, Name = name, Position = point, ReceivedAt = Time.time };
            var p = Player.localPlayer;
            Log(string.Format("server marker set: type '{0}', name '{1}', at {2}{3}", type, name, point,
                p != null ? ", " + Vector3.Distance(p.transform.position, point).ToString("0") + "m away" : ""));
        }

        internal static void Remove(string type, string name)
        {
            if (Points.Remove(Key(type, name))) Log("server marker removed: " + type + "/" + name);
        }

        internal static void RemoveAt(Vector3 point)
        {
            foreach (var k in Points.Where(kv => kv.Value.Position == point).Select(kv => kv.Key).ToList())
            {
                Points.Remove(k);
                Log("server marker removed at " + point + ": " + k);
            }
        }
    }

    static class DirectionPointHooks
    {
        [HarmonyPostfix, HarmonyPatch(typeof(Player), nameof(Player.UserCode_TargetSetDirectionPoint))]
        static void Set(string type, string name, Vector3 point) { ServerMarkers.Set(type, name, point); }

        [HarmonyPostfix, HarmonyPatch(typeof(Player), nameof(Player.UserCode_TargetRemoveDirectionPoint))]
        static void Remove(string type, string name) { ServerMarkers.Remove(type, name); }

        [HarmonyPostfix, HarmonyPatch(typeof(Player), nameof(Player.UserCode_TargetRemoveSameDirectionPoint))]
        static void RemoveSame(Vector3 point) { ServerMarkers.RemoveAt(point); }
    }
}
