using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Reflection;
using BepInEx.Configuration;
using UnityEngine;
using UnityEngine.AI;

namespace WT2Gatherer
{
    // Rectangle drawn on the in-game world map (Ctrl+drag while the map is open) that the gatherer
    // sweeps in lanes. Conversions mirror WTUIWorldMap: GetMapClickPosition for map -> world and
    // PlayerMarkUpdate's formula (offsetReal/offsetMap/scale) for world -> map.
    internal class ExploreArea
    {
        static readonly FieldInfo MapPanel = typeof(WTUIWorldMap).GetField("panel", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly FieldInfo MapCurrent = typeof(WTUIWorldMap).GetField("currentMap", BindingFlags.NonPublic | BindingFlags.Instance);
        static readonly FieldInfo MapContent = typeof(WTUIWorldMap).GetField("mapContentRectTransform", BindingFlags.NonPublic | BindingFlags.Instance);

        readonly ConfigEntry<string> area;
        readonly ConfigEntry<bool> enabled;
        readonly ConfigEntry<float> laneSpacing;
        readonly Action<string> trace;

        bool dragging;
        Vector3 dragStart;
        List<Vector3> sweep;      // cached lane waypoints for the current area
        string sweepFor;

        public ExploreArea(ConfigFile config, Action<string> trace)
        {
            this.trace = trace;
            area = config.Bind("Explore", "Area", "",
                "World rectangle x1,z1,x2,z2 to sweep when no target is in view. Set it with Ctrl+drag on the world map " +
                "(Ctrl+right-click on the map clears it).");
            enabled = config.Bind("Explore", "Enabled", true, "Sweep the area instead of the F9 waypoints when an area is set.");
            laneSpacing = config.Bind("Explore", "LaneSpacing", 70f,
                "Distance between sweep lanes (meters). The client sees about 51m around you, so ~70 keeps lanes overlapping.");
        }

        public bool Active { get { return enabled.Value && Bounds().HasValue; } }

        public string Describe()
        {
            var b = Bounds();
            if (!b.HasValue) return "no area (Ctrl+drag on the map)";
            return string.Format("{0:0}x{1:0}m{2}", b.Value.width, b.Value.height, enabled.Value ? "" : " (disabled)");
        }

        // x/y of the Rect are world x/z.
        Rect? Bounds()
        {
            var c = area.Value.Split(',');
            if (c.Length != 4) return null;
            float[] v = new float[4];
            for (int i = 0; i < 4; i++)
                if (!float.TryParse(c[i], NumberStyles.Float, CultureInfo.InvariantCulture, out v[i])) return null;
            return Rect.MinMaxRect(Mathf.Min(v[0], v[2]), Mathf.Min(v[1], v[3]), Mathf.Max(v[0], v[2]), Mathf.Max(v[1], v[3]));
        }

        void SetBounds(Vector3 a, Vector3 b)
        {
            area.Value = string.Format(CultureInfo.InvariantCulture, "{0:0},{1:0},{2:0},{3:0}", a.x, a.z, b.x, b.z);
            sweep = null;
            trace("explore area set to " + area.Value + " (" + Describe() + ")");
        }

        // Lawnmower lanes along x, spaced along z, a point every ~60m; heights snapped to the navmesh.
        // Points with no navmesh nearby (water, cliffs) are dropped.
        public List<Vector3> Sweep(Vector3 near)
        {
            var b = Bounds();
            if (!b.HasValue) return new List<Vector3>();
            string key = area.Value + "/" + laneSpacing.Value;
            if (sweep != null && sweepFor == key) return sweep;
            sweep = new List<Vector3>();
            sweepFor = key;
            float spacing = Mathf.Max(20f, laneSpacing.Value);
            int lanes = Mathf.Max(1, Mathf.CeilToInt(b.Value.height / spacing));
            int dropped = 0;
            for (int lane = 0; lane < lanes; lane++)
            {
                float z = b.Value.yMin + (lane + 0.5f) * b.Value.height / lanes;
                int steps = Mathf.Max(1, Mathf.CeilToInt(b.Value.width / 60f));
                for (int s = 0; s <= steps; s++)
                {
                    float t = lane % 2 == 0 ? (float)s / steps : 1f - (float)s / steps;
                    var want = new Vector3(Mathf.Lerp(b.Value.xMin, b.Value.xMax, t), near.y, z);
                    NavMeshHit hit;
                    if (NavMesh.SamplePosition(want, out hit, 200f, NavMesh.AllAreas)
                        && new Vector2(hit.position.x - want.x, hit.position.z - want.z).magnitude < 25f)
                        sweep.Add(hit.position);
                    else dropped++;
                }
            }
            trace("sweep: " + lanes + " lane(s), " + sweep.Count + " waypoint(s), " + dropped + " dropped (no walkable ground)");
            return sweep;
        }

        // ---- map overlay -------------------------------------------------------------------------

        public void OnMapGUI(Vector3? currentTarget)
        {
            var map = WTUIWorldMap.instance;
            if (map == null || MapPanel == null || MapCurrent == null || MapContent == null) return;
            var panel = MapPanel.GetValue(map) as GameObject;
            var coords = MapCurrent.GetValue(map) as WorldMapCoords;
            var content = MapContent.GetValue(map) as RectTransform;
            if (panel == null || !panel.activeInHierarchy || coords == null || content == null) return;

            GUI.Label(new Rect(Screen.width / 2f - 260, 8, 520, 24),
                "Gatherer: Ctrl+drag to set the explore area, Ctrl+right-click to clear (" + Describe() + ")");

            Event e = Event.current;
            if (e.control && e.type == EventType.MouseDown && e.button == 1) { area.Value = ""; sweep = null; trace("explore area cleared"); e.Use(); }
            if (e.control && e.type == EventType.MouseDown && e.button == 0)
            {
                Vector3 w = map.GetMapClickPosition(GuiToScreen(e.mousePosition));
                if (w.x != -1f || w.z != -1f) { dragging = true; dragStart = w; e.Use(); }
            }
            if (dragging && e.type == EventType.MouseUp && e.button == 0)
            {
                dragging = false;
                Vector3 w = map.GetMapClickPosition(GuiToScreen(e.mousePosition));
                if ((w.x != -1f || w.z != -1f) && Vector2.Distance(new Vector2(w.x, w.z), new Vector2(dragStart.x, dragStart.z)) > 10f)
                    SetBounds(dragStart, w);
                e.Use();
            }

            Rect? shown = null;
            if (dragging)
            {
                Vector3 w = map.GetMapClickPosition(GuiToScreen(e.mousePosition));
                if (w.x != -1f || w.z != -1f)
                    shown = Rect.MinMaxRect(Mathf.Min(dragStart.x, w.x), Mathf.Min(dragStart.z, w.z), Mathf.Max(dragStart.x, w.x), Mathf.Max(dragStart.z, w.z));
            }
            else shown = Bounds();
            if (!shown.HasValue) return;

            Vector2 a = WorldToGui(coords, content, new Vector3(shown.Value.xMin, 0, shown.Value.yMin));
            Vector2 b = WorldToGui(coords, content, new Vector3(shown.Value.xMax, 0, shown.Value.yMax));
            var r = Rect.MinMaxRect(Mathf.Min(a.x, b.x), Mathf.Min(a.y, b.y), Mathf.Max(a.x, b.x), Mathf.Max(a.y, b.y));
            Fill(r, new Color(1f, 0.85f, 0.2f, 0.12f));
            Outline(r, new Color(1f, 0.85f, 0.2f, 0.9f), 2f);
            if (dragging || sweep == null) return;
            foreach (var p in sweep)
            {
                Vector2 g = WorldToGui(coords, content, p);
                Fill(new Rect(g.x - 2, g.y - 2, 4, 4), new Color(1f, 0.85f, 0.2f, 0.8f));
            }
            if (currentTarget.HasValue)
            {
                Vector2 g = WorldToGui(coords, content, currentTarget.Value);
                Fill(new Rect(g.x - 4, g.y - 4, 8, 8), new Color(0.3f, 1f, 0.3f, 1f));
            }
        }

        static Vector2 GuiToScreen(Vector2 gui) { return new Vector2(gui.x, Screen.height - gui.y); }

        static Vector2 WorldToGui(WorldMapCoords m, RectTransform content, Vector3 w)
        {
            var local = new Vector2((w.x - m.offsetReal.x) * m.scale + m.offsetMap.x, (w.z - m.offsetReal.z) * m.scale + m.offsetMap.y);
            Vector2 screen = RectTransformUtility.WorldToScreenPoint(null, content.TransformPoint(local));
            return new Vector2(screen.x, Screen.height - screen.y);
        }

        static void Fill(Rect r, Color c)
        {
            var saved = GUI.color;
            GUI.color = c;
            GUI.DrawTexture(r, Texture2D.whiteTexture);
            GUI.color = saved;
        }

        static void Outline(Rect r, Color c, float t)
        {
            Fill(new Rect(r.xMin, r.yMin, r.width, t), c);
            Fill(new Rect(r.xMin, r.yMax - t, r.width, t), c);
            Fill(new Rect(r.xMin, r.yMin, t, r.height), c);
            Fill(new Rect(r.xMax - t, r.yMin, t, r.height), c);
        }
    }
}
