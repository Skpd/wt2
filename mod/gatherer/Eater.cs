using System;
using System.Linq;
using BepInEx.Configuration;
using UnityEngine;

namespace WT2Gatherer
{
    // Eats from the inventory while the player has the "Hunger" effect (Player.EFFECT_HUNGER).
    // Player.food holds one satiety value per FoodType (max Player.FOOD_TYPE_MAX); food items are
    // WTUsableItems with FoodValue[] foods. Picks the item that fills the emptiest types the most and
    // eats it like a double-click on the item (CmdUseInventoryItem).
    internal class Eater
    {
        readonly ConfigEntry<bool> autoEat, allowRaw, allowAlcohol;
        readonly Action<string> log;
        float busyUntil;
        bool warnedNoFood;
        public int Eaten;

        public Eater(ConfigFile config, Action<string> log)
        {
            this.log = log;
            autoEat = config.Bind("Food", "AutoEat", true, "Eat from the inventory when you get the Hunger effect (gather bot and fishing helper).");
            allowRaw = config.Bind("Food", "AllowRawFood", false, "Also eat raw food (raw meat, raw fish...).");
            allowAlcohol = config.Bind("Food", "AllowAlcohol", false, "Also drink alcohol.");
        }

        public static bool IsHungry(Player p)
        {
            foreach (var e in p.effects)
                if (e.name == Player.EFFECT_HUNGER) return true;
            return false;
        }

        // True while eating (or waiting for the server's food update), so the caller holds off.
        public bool Tick(Player p)
        {
            if (Time.time < busyUntil) return true;
            if (!autoEat.Value || !IsHungry(p)) { warnedNoFood = false; return false; }

            int best = -1;
            float bestScore = 0;
            string bestName = null;
            for (int i = 0; i < p.inventory.Count; i++)
            {
                var slot = p.inventory[i];
                if (slot.amount <= 0) continue;
                var food = slot.item.data as WTUsableItem;
                if (food == null || food.foods == null || food.foods.Length == 0) continue;
                if (food.rawFoodType && !allowRaw.Value) continue;
                if (food.alcoholValue > 0 && !allowAlcohol.Value) continue;
                if (p.IsFull(food.foods, food.rawFoodType)) continue;
                float score = food.foods.Sum(f => Mathf.Min(f.value, Player.FOOD_TYPE_MAX - Satiety(p, f.type)));
                if (score > bestScore) { bestScore = score; best = i; bestName = slot.item.name; }
            }
            if (best < 0)
            {
                if (!warnedNoFood) log("hungry, but no suitable food in the inventory (see [Food] settings)");
                warnedNoFood = true;
                return false;
            }
            p.CmdUseInventoryItem(best);
            Eaten++;
            busyUntil = Time.time + 5f;   // use time + server food update
            log("hungry: eating " + bestName + " (food " + string.Join("/", p.food.Select(v => v.ToString()).ToArray()) + ")");
            return true;
        }

        static int Satiety(Player p, FoodType type)
        {
            int i = (int)type;
            return p.food != null && i >= 0 && i < p.food.Length ? p.food[i] : 0;
        }
    }
}
