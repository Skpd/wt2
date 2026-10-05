"""Turn raw game data into the wiki's data model.

Every entity is keyed by its internal game name (``m_Name`` / ``typeName``),
which is also the suffix of its locale key (``Item.<id>``, ``Entity.<id>``,
...). Cross references are plain ids; links to other kinds of entities use
``{"t": kind, "id": id}``. Reverse references ("dropped by", "used in", ...)
are computed here so the frontend only has to render them.
"""

from __future__ import annotations

import logging
import re
from collections import defaultdict

from .unity import Game, loads_lenient

log = logging.getLogger(__name__)

ITEM_KINDS = {
    "WTScriptableItem": "material",
    "WTEquipmentItem": "equipment",
    "WTWeaponItem": "weapon",
    "WTUsableItem": "consumable",
    "WTAmmoItem": "ammo",
    "WTMountItem": "mount",
    "WTPetItem": "pet",
    "WTHomeAnimalItem": "animal",
    "WTBigFishItem": "fish",
    "WTWitchcraftOrgan": "organ",
    "WTSacrificialOrgan": "organ",
    "WTSkillBookItem": "book",
    "WTItemsGroup": "group",
}

SPAWN_LISTS = {
    "spawns": None,
    "christmasSpawns": "christmas",
    "halloweenSpawns": "halloween",
    "easterSpawns": "easter",
    "pvpEventSpawns": "pvp",
}

LOCALE_PREFIXES = (
    "Item.", "Entity.", "Quest.", "WorldObject.", "Bonus.", "Skill.", "Effect.",
    "Passive.", "CraftFolder.", "BuildFolder.", "FoodType.", "UI.World.Areas.",
    "UI.ItemToolTip.", "UI.MobFeatures.", "UI.AuctionCategory.", "Overlay.EntityDanger.",
    "UI.DungeonLevel.Difficulty.",
)

NOISE_KEYS = {
    "m_GameObject", "m_Script", "m_Enabled", "damageZoneOnAttack", "boneBinding",
    "femaleBoneBinding", "additionalBoneBinding", "leftHandBoneBinding",
}


def num(x):
    """Compact numbers: 0.07999999821 -> 0.08, 3.0 -> 3."""
    if isinstance(x, float):
        if x.is_integer() and abs(x) < 1e15:
            return int(x)
        return float(f"{x:.6g}")
    return x


def compact(d):
    """Drop empty/zero values from a dict (shallow)."""
    return {k: v for k, v in d.items() if v not in (None, 0, 0.0, "", [], {}, False)}


class Builder:
    def __init__(self, game: Game):
        self.g = game
        self.so = game.scriptable_objects()
        self.enums = game.enums()
        self.texts = game.text_assets()
        self.by_cls: dict[str, dict[str, dict]] = defaultdict(dict)
        self.name_of: dict[int, str] = {}
        self.cls_of: dict[int, str] = {}
        for pid, (cls, d) in sorted(self.so.items()):
            name = d["m_Name"]
            if name in self.by_cls[cls]:
                log.warning("duplicate %s %s", cls, name)
            self.by_cls[cls].setdefault(name, d)
            self.name_of[pid] = name
            self.cls_of[pid] = cls
        self.icon_sprites: dict[str, int] = {}  # icon stem -> sprite path id
        self._icon_of: dict[int, str] = {}
        self.warnings: list[str] = []

    # ---- helpers ------------------------------------------------------------

    def json_asset(self, name):
        if name not in self.texts:
            self.warn(f"missing TextAsset {name}")
            return None
        return loads_lenient(self.texts[name])

    def warn(self, msg):
        if msg not in self.warnings:
            self.warnings.append(msg)
            log.warning(msg)

    def ref(self, ptr) -> str | None:
        pid = ptr.get("m_PathID", 0) if isinstance(ptr, dict) else 0
        return self.name_of.get(pid) if pid else None

    def kind_of_pid(self, pid) -> str | None:
        cls = self.cls_of.get(pid)
        if cls is None:
            return None
        if cls in ITEM_KINDS:
            return "item"
        if cls == "WTEntityType":
            return "mob"
        if cls == "WTNpcType":
            return "npc"
        if cls == "WTWorldType":
            return "object"
        if cls.endswith("Quest"):
            return "quest"
        if cls == "WTScriptableEffect":
            return "effect"
        return cls

    def link(self, ptr) -> dict | None:
        """Typed reference for a PPtr to a ScriptableObject or a spawn prefab."""
        pid = ptr.get("m_PathID", 0) if isinstance(ptr, dict) else 0
        if not pid:
            return None
        if pid in self.so:
            return {"t": self.kind_of_pid(pid), "id": self.name_of[pid]}
        info = self.g.prefab(pid)
        if info.get("entityType") in self.so:
            et = info["entityType"]
            return {"t": self.kind_of_pid(et), "id": self.name_of[et]}
        if info.get("worldType") in self.so:
            return {"t": "object", "id": self.name_of[info["worldType"]]}
        if info.get("name"):
            return {"t": "prefab", "id": info["name"]}
        return None

    def icon(self, ptr) -> str | None:
        pid = ptr.get("m_PathID", 0) if isinstance(ptr, dict) else 0
        if not pid:
            return None
        if pid in self._icon_of:
            return self._icon_of[pid]
        obj = self.g.objects.get(pid)
        if obj is None or obj.type.name != "Sprite":
            return None
        stem = re.sub(r"[^A-Za-z0-9_-]+", "_", obj.peek_name() or f"sprite{pid}")
        if stem in self.icon_sprites:
            stem = f"{stem}_{pid}"
        self.icon_sprites[stem] = pid
        self._icon_of[pid] = stem
        return stem

    def enum(self, enum, value):
        for name, v in self.enums.get(enum, {}).items():
            if v == value:
                return name
        return value

    def category(self, cat) -> tuple[list[str], list[str]]:
        """Auction categories as (primary path, every matching category).

        Each level is a bit mask (a pickaxe is both a tool and a blunt
        weapon), and sub-category values restart under each parent, so a
        name only counts if it is prefixed by a matching parent's name.
        """
        path, every, parents = [], [], [""]
        for level in (1, 2, 3):
            value = cat.get(f"category{level}") or 0
            names = [n for n, v in self.enums.get(f"AuctionCategory{level}", {}).items()
                     if v and value & v == v and any(n.startswith(p) for p in parents)]
            primary = [n for n in names if n.startswith(path[-1] if path else "")]
            if not primary:
                break
            enum = self.enums[f"AuctionCategory{level}"]
            path.append(max(primary, key=lambda n: enum[n]))  # the higher bit is the more specific one
            every += names
            parents = names
        return path, every

    def clean(self, v):
        """Generic cleanup for nested structures: resolve refs, drop empties."""
        if isinstance(v, dict):
            if set(v) == {"m_FileID", "m_PathID"}:
                return self.ref(v)
            out = {}
            for k, x in v.items():
                if k in NOISE_KEYS:
                    continue
                x = self.clean(x)
                if x not in (None, 0, 0.0, "", [], {}):
                    out[k] = x
            return out
        if isinstance(v, list):
            return [x for x in (self.clean(x) for x in v) if x not in (None, "", {}, [])]
        return num(v)

    def bonuses(self, lst):
        return [[b["name"], num(b["value"])] for b in lst or [] if b.get("name")]

    def effects(self, lst):
        """[{effect, chance, time}] lists used all over the place."""
        out = []
        for e in lst or []:
            name = self.ref(e.get("effect"))
            if name:
                out.append(compact({"effect": name, "chance": num(e.get("chance", 0)), "time": num(e.get("time", 0))}))
        return out

    # ---- build -----------------------------------------------------------

    def build(self) -> dict:
        self.items = {n: self.item(c, n, d) for c in ITEM_KINDS for n, d in self.by_cls[c].items()}
        self.effects_ = {n: self.effect(d) for n, d in self.by_cls["WTScriptableEffect"].items()}
        self.bonus_info = self.build_bonuses()
        self.gathers = {n: self.gather(d) for n, d in self.by_cls["WTScriptableGather"].items()}
        self.objects = {n: self.world_object(d) for n, d in self.by_cls["WTWorldType"].items()}
        self.mobs = {n: self.mob(d) for n, d in self.by_cls["WTEntityType"].items()}
        self.npcs = {n: self.npc(d) for n, d in self.by_cls["WTNpcType"].items()}
        self.quests = {n: self.quest(c, d) for c in self.by_cls if c.endswith("Quest") for n, d in self.by_cls[c].items()}
        self.areas = {n: self.area(d) for n, d in self.by_cls["WTScriptableArea"].items()}
        self.recipes = self.build_recipes()
        self.loot = self.build_loot()
        self.fishing = self.build_fishing()
        self.skills = self.build_skills()
        self.link_everything()
        return {
            "items": self.items,
            "mobs": self.mobs,
            "npcs": self.npcs,
            "objects": self.objects,
            "quests": self.quests,
            "recipes": self.recipes,
            "loot": self.loot,
            "gathers": self.gathers,
            "areas": self.areas,
            "fishing": self.fishing,
            "effects": self.effects_,
            "bonuses": self.bonus_info,
            "skills": self.skills,
        }

    # ---- items -------------------------------------------------------------

    def item(self, cls, name, d) -> dict:
        cat, cats = self.category(d.get("auctionItemCategory", {}))
        it = {
            "kind": ITEM_KINDS[cls],
            "icon": self.icon(d.get("image")),
            "rarity": self.enum("RarityType", d.get("baseRarity")),
            "cat": cat,
            "cats": cats if len(cats) > len(cat) else None,
            "stack": d.get("maxStack") if d.get("maxStack", 1) > 1 else None,
            "price": num(d.get("sellPrice")),
            "buyUp": num(d.get("buyUpPrice")),
            "repair": num(d.get("repairPrice")),
            "xp": d.get("xpGain"),
            "flags": [f for f, k in (
                ("noDeathDrop", "dontDropOnDeath"), ("noTrade", "cantTradeOrLayOut"),
                ("lootOnly", "lootOnly"), ("questItem", "removableQuestItem"),
                ("hidden", "hidenInJournal"),
            ) if d.get(k)],
            "note": self.enum("ItemSpecialNote", d["specialNote"]) if d.get("specialNote") else None,
            "slot": d.get("equipSlotName"),
            "req": compact({"skill": d.get("fixedSkillNameRequired"), "level": d.get("skillRequired")}),
            "durability": d.get("maxDurability"),
            "quality": bool(d.get("hasQuality")),
            "bonuses": self.bonuses(d.get("bonuses")),
            "use": compact({
                "time": num(d.get("timeToUse", 0)),
                "effects": self.effects(d.get("useEffects")),
                "removes": [self.ref(e) for e in d.get("useRemoveEffects", []) if self.ref(e)],
                "foods": [compact({"type": self.enum("FoodType", f.get("type", 0)), "value": num(f.get("value"))}) for f in d.get("foods", [])],
                "raw": d.get("rawFoodType"),
                "drink": d.get("drinkFoodType"),
                "alcohol": num(d.get("alcoholValue", 0)),
                "petXp": d.get("addPetXp"),
                "petMaxLevel": d.get("petMaxLevel"),
            }),
            "butcher": self.ref(d.get("butchedItems")),
            "essence": self.ref(d.get("essenceItems")),
            "startQuest": self.ref(d.get("startQuest")),
        }
        if cls == "WTWeaponItem":
            atk = self.clean(d.get("attack", {}))
            for k in ("effects", "effectsHard", "effectsNightmare"):
                if k in d.get("attack", {}):
                    atk[k] = self.effects(d["attack"][k]) or None
            it["attack"] = compact(atk)
            it["weaponSkill"] = self.skill_prof(d.get("damageSkill"))
            it["ammo"] = self.ref(d.get("requiredAmmo"))
            it["oathVariant"] = self.ref(d.get("oathBoundVariant"))
        if cls == "WTAmmoItem":
            it["ammoStats"] = compact({
                "damage": d.get("addAmmoDamage"),
                "ignoreDefense": num(d.get("addAmmoIgnoreDefense", 0)),
                "maxLevel": d.get("asAmmoEntityMaxLevel"),
                "effects": self.effects(d.get("ammoEffects")),
            })
        if cls in ("WTPetItem", "WTMountItem"):
            it["mountEffect"] = self.ref(d.get("mountEffect"))
        if cls == "WTPetItem":
            it["pet"] = compact({
                "tameLevel": d.get("tameLevel"),
                "fear": d.get("fearOnCatch"),
                "feed": self.ref(d.get("feedItem")),
                "revivePrice": d.get("revivePrice"),
                "levels": self.clean(d.get("petLevels", {})),
            })
        if cls == "WTItemsGroup":
            it["group"] = [self.ref(x) for x in d.get("items", []) if self.ref(x)]
        if cls in ("WTWitchcraftOrgan", "WTSacrificialOrgan") or d.get("itemEffects"):
            organs = d.get("itemEffects") or [d]
            it["enchant"] = [compact({
                "level": d.get("witchcraftLevel"),
                "charges": o.get("charges"),
                "vs": self.enum("EntityClass", o["enemyClass"]) if o.get("enemyClass") else None,
                "values": self.clean(o.get("attackValues", {})),
                "effect": (self.effects([o["attackEffect"]]) or [None])[0] if o.get("attackEffect") else None,
            }) for o in organs]
        if cls == "WTBigFishItem":
            it["fishWeight"] = num(d.get("fishBasicWeight"))
        if cls == "WTSkillBookItem":
            it["book"] = compact({"xpBonus": num(d.get("addXPBonusPercent", 0)), "time": num(d.get("baseTime", 0))})
        if d.get("seedSkillLevel"):
            it["seedLevel"] = d["seedSkillLevel"]
        if d.get("isFishingBait"):
            it["flags"].append("bait")
        return compact(it)

    def skill_prof(self, ptr):
        pid = ptr.get("m_PathID", 0) if isinstance(ptr, dict) else 0
        if pid in self.so:
            return self.so[pid][1].get("profSkillName") or None
        return None

    def effect(self, d) -> dict:
        return compact({
            "icon": self.icon(d.get("icon")),
            "bonuses": self.bonuses(d.get("bonuses")),
            "group": self.enum("EffectGroupType", d["effectGroup"]) if d.get("effectGroup") else None,
            "hidden": bool(d.get("hidden")),
            "negative": bool(d.get("negativeForClear")),
        })

    def build_bonuses(self) -> dict:
        out = {}
        for n, d in self.by_cls["WTScriptableBonus"].items():
            out[n] = compact({
                "pct": bool(d.get("asPercent")),
                "int": bool(d.get("asInteger")),
                "sign": bool(d.get("showSign")),
                "hide": not d.get("showValue"),
                "max": num(d.get("maximum", 0)),
                "cat": self.enum("BonusCategory", d.get("bonusCategory")),
            })
        return out

    # ---- world objects / gathering ------------------------------------------

    def gather(self, d) -> dict:
        return compact({
            "skill": d.get("profSkillName"),
            "level": d.get("skillLevel"),
            "tool": self.ref(d.get("bonusRequired")),
            "needs": [compact({"item": self.ref(x.get("item")), "amount": x.get("amount")}) for x in d.get("itemRequired", [])],
            "items": [compact({
                "item": self.ref(x.get("item")),
                "chance": num(x.get("chance")),
                "min": x.get("amount"),
                "max": x.get("amountMax"),
            }) for x in d.get("success", []) if self.ref(x.get("item"))],
            "consumes": bool(d.get("removeOnGather")),
        })

    def world_object(self, d) -> dict:
        tool = d.get("worldTool", {})
        provides = []
        for e in d.get("structureEffect", {}).get("effects", []):
            en = self.ref(e)
            if en:
                provides.append(en)
                provides += [b[0] for b in self.effects_.get(en, {}).get("bonuses", [])]
        states = []
        for s in d.get("states", []):
            g = self.ref(s.get("stateGather")) or self.ref(s.get("changeState", {}).get("gatherOnChange"))
            if g:
                states.append({"state": s.get("name"), "gather": g})
        return compact({
            "icon": self.icon(d.get("image")) or self.icon(d.get("buildIcon")),
            "gather": self.ref(d.get("gatherSettings")),
            "stateGathers": states,
            "produce": [self.ref(p) for p in tool.get("produceProcesses", []) if self.ref(p)],
            "fuels": [compact({"item": self.ref(f.get("item")), "amount": f.get("amount")}) for f in tool.get("fuels", []) if self.ref(f.get("item"))],
            "timer": num(tool.get("timer", 0)),
            "provides": sorted(set(provides)),
            "slots": d.get("containerSlots"),
            "upgradeTo": self.ref(d.get("upgradeTo", {}).get("worldType")),
            "upgradeCost": [compact({"item": self.ref(m.get("item")), "amount": m.get("amount")}) for m in d.get("upgradeTo", {}).get("materials", [])],
        })

    # ---- mobs / npcs -----------------------------------------------------------

    def combat_skill(self, ptr) -> dict | None:
        pid = ptr.get("m_PathID", 0) if isinstance(ptr, dict) else 0
        if pid not in self.so:
            return None
        cls, d = self.so[pid]
        atk = d.get("attack", {})
        out = {
            "id": d["m_Name"],
            "kind": cls.removeprefix("WT"),
            "cast": num(d.get("baseCastTime", 0)),
            "cooldown": num(d.get("baseCooldownTime", 0)),
            "range": num(d.get("baseCastRange", 0)),
            "belowHp": num(d["castOnHealthBelow"]) if d.get("castOnHealthBelow", 1) < 1 else None,
            "onCaster": self.effects(d.get("onCaster")),
            "onTarget": self.effects(d.get("onTarget")),
        }
        if atk:
            a = self.clean(atk)
            a.pop("abilityName", None)
            for k in ("effects", "effectsHard", "effectsNightmare"):
                a[k] = self.effects(atk.get(k)) or None
            out["attack"] = compact(a)
        return compact(out)

    def creature(self, d) -> dict:
        prefab = self.g.prefab(d["entityPrefab"]["m_PathID"]) if d.get("entityPrefab", {}).get("m_PathID") else {}
        corpse = self.name_of.get(prefab.get("worldType", 0))
        if not corpse and f"{d['m_Name']}Corpse" in self.by_cls["WTWorldType"]:
            corpse = f"{d['m_Name']}Corpse"
        return {
            "icon": self.icon(d.get("image")),
            "level": d.get("level"),
            "hp": d.get("health"),
            "hpRegen": d.get("healthRecoveryInSec"),
            "stamina": d.get("stamina"),
            "walk": num(d.get("walkSpeed")),
            "run": num(d.get("runSpeed")),
            "invincible": bool(d.get("invincible")),
            "corpse": corpse,
            "xp": prefab.get("xp"),
            "skillXp": prefab.get("skillXp"),
        }

    def mob(self, d) -> dict:
        m = self.creature(d)
        m.update({
            "danger": self.enum("EntityDanger", d.get("danger", 0)),
            "class": self.enum("EntityClass", d.get("entityClass", 0)),
            "behaviour": self.ref(d.get("mobBehaviour")),
            "bonuses": self.bonuses(d.get("entityBonuses")),
            "bonusesHard": self.bonuses(d.get("entityBonusesHard")),
            "bonusesNightmare": self.bonuses(d.get("entityBonusesNightmare")),
            "skills": [s for s in (self.combat_skill(p) for p in d.get("skills", [])) if s],
            "pet": self.ref(d.get("catchType", {}).get("item")),
        })
        if m["danger"] == "Usual":
            m["danger"] = None
        if m["class"] == "None":
            m["class"] = None
        return compact(m)

    def npc(self, d) -> dict:
        n = self.creature(d)
        shop = self.by_cls["WTNpcShop"].get(self.ref(d.get("shop")) or "")
        buy = self.by_cls["WTNpcBuyUp"].get(self.ref(d.get("buyUp")) or "")
        if shop:
            pct = shop.get("pricesPercent", 1) or 1
            n["shop"] = []
            for s in shop.get("shopItems", []):
                item = self.ref(s.get("itemType"))
                if not item:
                    continue
                currency = self.ref(s.get("currencyItem"))
                base = self.items.get(item, {}).get("price", 0)
                n["shop"].append(compact({
                    "item": item,
                    "amount": s.get("amount"),
                    "quality": s.get("qualityOrPetLevel"),
                    "book": s.get("bookSkill"),
                    "currency": currency,
                    "price": s.get("currencyAmount") if currency else num(base * pct),
                }))
        if buy:
            n["buys"] = compact({
                "usual": num(buy.get("usualPercent")),
                "special": num(buy.get("specialPercent")),
                "skills": buy.get("craftSpecialSkills"),
                "items": [self.ref(x) for x in buy.get("specialItems", []) if self.ref(x)],
            })
        n["services"] = [s for s, k in (
            ("repair", "canRepair"), ("expedition", "expedition"), ("endExpedition", "endExpedition"),
            ("guild", "canNewGuild"), ("serverTransfer", "serverTransfer"),
        ) if d.get(k)]
        n.pop("corpse", None)
        return compact(n)

    # ---- quests ----------------------------------------------------------------

    QUEST_COMMON = {
        "m_GameObject", "m_Enabled", "m_Script", "m_Name", "line", "giver", "taker", "reward",
        "isTutorial", "isDaily", "hideDailyQuest", "isItemRepeatableQuest", "canBeSkipped",
        "autoComplete", "removeQuestLineAfterComplete", "successors", "additionalOutline",
        "guildLevelMin", "guildLevelMax",
    }

    def quest(self, cls, d) -> dict:
        reward = d.get("reward", {})
        goal = {}
        for k, v in d.items():
            if k in self.QUEST_COMMON:
                continue
            if isinstance(v, dict) and set(v) == {"m_FileID", "m_PathID"}:
                v = self.link(v)
            elif isinstance(v, list) and v and isinstance(v[0], dict) and set(v[0]) == {"m_FileID", "m_PathID"}:
                v = [x for x in (self.link(p) for p in v) if x]
            else:
                v = self.clean(v)
            if v not in (None, 0, 0.0, "", [], {}):
                goal[k] = v
        if "targetEntityClass" in goal:
            goal["targetEntityClass"] = self.enum("EntityClass", goal["targetEntityClass"])
        return compact({
            "kind": cls.removeprefix("WT").removesuffix("Quest"),
            "line": self.enum("QuestLineType", d.get("line", 0)),
            "daily": bool(d.get("isDaily")),
            "tutorial": bool(d.get("isTutorial")),
            "repeatable": bool(d.get("isItemRepeatableQuest")),
            "giver": self.ref(d.get("giver", {}).get("npcGiver")),
            "taker": self.ref(d.get("taker", {}).get("npcTaker")),
            "prev": [self.ref(p) for p in d.get("giver", {}).get("predecessors", []) if self.ref(p)],
            "next": [self.ref(p) for p in d.get("successors", []) if self.ref(p)],
            "guildLevel": d.get("guildLevelMin"),
            "reward": compact({
                "money": reward.get("money"),
                "guildXp": reward.get("guildXp"),
                "item": self.ref(reward.get("rewardItem")),
                "amount": reward.get("amount"),
                "book": reward.get("bookSkill"),
            }),
            "goal": goal,
        })

    def area(self, d) -> dict:
        spawns = []
        for key, event in SPAWN_LISTS.items():
            for s in d.get(key, []):
                target = self.link(s.get("spawnPrefab"))
                if not target:
                    continue
                spawns.append(compact({
                    **target,
                    "density": num(s.get("density")),
                    "respawn": num(s.get("respawnTime")),
                    "event": event,
                }))
        return compact({
            "spawns": spawns,
            "effects": [self.ref(e) for e in d.get("effects", []) if self.ref(e)],
            "noBuild": bool(d.get("buildForbidden")),
            "claim": bool(d.get("claimAllowed")),
        })

    # ---- recipes -----------------------------------------------------------------

    def build_recipes(self) -> dict:
        recipes = {}

        def add(rid, r):
            base, i = rid, 2
            while rid in recipes:
                rid = f"{base}#{i}"
                i += 1
            recipes[rid] = compact(r)

        def walk(node, kind, path, event):
            event = event or next((e for e in ("Christmas", "Halloween", "Easter", "PvpEvent") if node.get(f"is{e}")), None)
            if node.get("testClientOnly"):
                return
            if "typeName" in node:
                t = node["typeName"]
                out = {"t": "object", "id": t} if kind == "build" else {"item": t, "amount": node.get("amount", 1)}
                add(f"{kind}:{t}", {
                    "type": kind,
                    "out": [out],
                    "in": [{"item": m, "amount": v.get("amount", 1)} for m, v in node.get("materials", {}).items()],
                    "skill": node.get("skill"),
                    "level": node.get("level"),
                    "xpMod": node.get("xpMod"),
                    "tool": node.get("toolRequired"),
                    "stations": node.get("bonusesRequired"),
                    "time": num(node.get("createTimeMs", 0) / 1000),
                    "folder": path,
                    "event": event,
                    "hidden": bool(node.get("hidden")),
                    "claimOnly": bool(node.get("inClaimOnly") or node.get("yourClaimOnly")),
                    "randomBonus": compact({
                        "list": node.get("randomBonusList"),
                        "count": node.get("randomBonusCount"),
                        "rareList": node.get("randomBonusRareList"),
                        "rareCount": node.get("randomBonusRareCount"),
                    }),
                })
            for child in node.get("childs", []):
                walk(child, kind, path + ([node["name"]] if node.get("name") and "typeName" not in node else []), event)

        for kind in ("craft", "build"):
            for root in self.json_asset(kind) or []:
                walk(root, kind, [], None)

        stations = defaultdict(list)
        for oid, o in self.objects.items():
            for p in o.get("produce", []):
                stations[p].append(oid)
        for cls, kind in (
            ("WTProduceProcess", "produce"),
            ("WTProduceWithOrgansProcess", "produce"),
            ("WTProduceProcessAnimalFeed", "feed"),
            ("WTProduceProcessAnimalPairing", "pairing"),
        ):
            for n, d in self.by_cls[cls].items():
                ins = [compact({"item": self.ref(x.get("item")), "amount": x.get("amount")}) for x in d.get("resources", [])]
                outs = [compact({"item": self.ref(x.get("item")), "amount": x.get("amount")}) for x in d.get("products", [])]
                if kind == "feed" and self.ref(d.get("animal", {}).get("item")):
                    ins.insert(0, {"item": self.ref(d["animal"]["item"]), "amount": d["animal"].get("amount", 1), "kept": True})
                if kind == "pairing":
                    for role in ("father", "mother"):
                        if self.ref(d.get(role, {}).get("item")):
                            ins.insert(0, {"item": self.ref(d[role]["item"]), "amount": d[role].get("amount", 1), "kept": True})
                    if self.ref(d.get("child", {}).get("item")):
                        outs.insert(0, {"item": self.ref(d["child"]["item"]), "amount": d["child"].get("amount", 1)})
                add(f"{kind}:{n}", {
                    "type": kind,
                    "name": n,
                    "in": [x for x in ins if x.get("item")],
                    "out": [x for x in outs if x.get("item")],
                    "at": stations.get(n),
                    "secret": bool(d.get("secret")),
                })
        return recipes

    # ---- loot ----------------------------------------------------------------------

    def build_loot(self) -> dict:
        loot = {}
        for source, key in (("drop", "worldTypes"), ("gift", None)):
            for tid, t in (self.json_asset(source) or {}).items():
                entries = []
                for e in t.get("list", []):
                    entries.append(compact({
                        "n": len(e.get("randomList", [])),
                        "chance": num(e.get("chance", 1)),
                        "minDifficulty": e.get("minDifficulty"),
                        "maxDifficulty": e.get("maxDifficulty"),
                        "event": "christmas" if e.get("isChristmas") else None,
                        "items": weighted(compact({
                            "item": r.get("typeName"),
                            "min": r.get("amount"),
                            "max": r.get("amountMax"),
                            "qmin": r.get("qualityMin"),
                            "qmax": r.get("qualityMax"),
                        }) for r in e.get("randomList", [])),
                    }))
                money = t.get("money")
                frm = [{"t": "object", "id": w} for w in t.get(key, [])] if key else [{"t": "item", "id": tid}]
                loot[tid] = compact({
                    "kind": source,
                    "from": frm,
                    "money": compact({"chance": num(money.get("chance", 1)), "min": money.get("amount"), "max": money.get("amountMax")}) if money else None,
                    "entries": entries,
                    "solo": bool(t.get("soloGiftType")),
                })
        return loot

    # ---- fishing / skills -------------------------------------------------------------

    def build_fishing(self) -> dict:
        fish = {}
        for n, d in self.by_cls["WTFish"].items():
            fish[n] = compact({
                "items": [self.ref(x) for x in d.get("itemTypes", []) if self.ref(x)],
                "level": d.get("fishingLevel"),
                "chance": num(d.get("chance")),
                "baits": [self.ref(x) for x in d.get("baits", []) if self.ref(x)],
                "areas": {},
            })
        areas = {}
        for n, d in self.by_cls["WTFishingArea"].items():
            names = [self.ref(x) for x in d.get("fishes", []) if self.ref(x)]
            weights = {f: names.count(f) / len(names) for f in dict.fromkeys(names)} if names else {}
            areas[n] = compact({"fishes": {f: num(w) for f, w in weights.items()}, "fail": num(d.get("fishingFailChance"))})
            for f, w in weights.items():
                if f in fish:
                    fish[f].setdefault("areas", {})[n] = num(w)
        return {"fish": fish, "areas": areas}

    def build_skills(self) -> dict:
        data = self.json_asset("skills") or {}
        skills = {n: compact({
            "type": s.get("type"),
            "combat": bool(s.get("combat")),
            "cap": s.get("levelCap"),
            "xpMod": s.get("xpMod"),
            "passives": [],
        }) for n, s in data.get("list", {}).items()}
        for n, d in sorted(self.by_cls["WTPassiveSkill"].items(), key=lambda x: x[1].get("profSkillLevel", 0)):
            sk = d.get("profSkillName")
            skills.setdefault(sk, {}).setdefault("passives", []).append(compact({
                "id": n,
                "icon": self.icon(d.get("image")),
                "level": d.get("profSkillLevel"),
                "bonuses": self.bonuses(d.get("bonuses")),
            }))
        for n, d in [*self.by_cls["WTAbilitySkill"].items(), *self.by_cls["WTAbilityTargetSkill"].items()]:
            sk = d.get("profSkillName")
            if sk:
                skills.setdefault(sk, {}).setdefault("abilities", []).append(compact({
                    "id": n,
                    "icon": self.icon(d.get("image")),
                    "level": d.get("profSkillLevel"),
                    "cooldown": num(d.get("baseCooldownTime", 0)),
                    "stamina": d.get("baseStaminaCost"),
                }))
        for s in skills.values():
            s.get("abilities", []).sort(key=lambda a: a.get("level", 0))
        return skills

    # ---- reverse references -------------------------------------------------------

    def link_everything(self):
        items, mobs, objects = self.items, self.mobs, self.objects

        def src(item_id, key, value):
            it = items.get(item_id)
            if it is None:
                self.warn(f"unknown item referenced: {item_id}")
                return
            it.setdefault("src", {}).setdefault(key, []).append(value)

        def use(item_id, key, value):
            it = items.get(item_id)
            if it is None:
                self.warn(f"unknown item referenced: {item_id}")
                return
            lst = it.setdefault("use", {}).setdefault(key, [])
            if value not in lst:
                lst.append(value)

        # recipes
        for rid, r in self.recipes.items():
            for o in r.get("out", []):
                if "item" in o:
                    src(o["item"], "recipe", rid)
                elif o.get("t") == "object" and o["id"] in objects:
                    objects[o["id"]].setdefault("recipes", []).append(rid)
            for i in r.get("in", []):
                use(i["item"], "recipe", rid)

        # tools and stations: which items/objects provide a bonus
        providers = defaultdict(lambda: {"items": [], "objects": []})
        for iid, it in items.items():
            for b, _ in it.get("bonuses", []):
                providers[b]["items"].append(iid)
        for oid, o in objects.items():
            for b in o.get("provides", []):
                providers[b]["objects"].append(oid)
        needed = set()
        for r in self.recipes.values():
            needed.update([r.get("tool")] + r.get("stations", []))
        for g in self.gathers.values():
            needed.add(g.get("tool"))
        for b in needed - {None}:
            self.bonus_info.setdefault(b, {})["providers"] = compact(providers.get(b, {}))

        # loot tables -> objects/mobs -> items
        corpse_of = defaultdict(list)
        for mid, m in mobs.items():
            if m.get("corpse"):
                corpse_of[m["corpse"]].append(mid)
        for tid, t in self.loot.items():
            for f in t["from"]:
                if f["t"] == "object":
                    if f["id"] in objects:
                        objects[f["id"]].setdefault("loot", []).append(tid)
                    for mid in corpse_of.get(f["id"], []):
                        mobs[mid].setdefault("loot", []).append(tid)
                elif f["t"] == "item" and f["id"] in items:
                    items[f["id"]].setdefault("contains", []).append(tid)
            for iid, p in loot_chances(t).items():
                src(iid, "loot", {"table": tid, **p})

        # gathering: which objects/items/mobs lead to a gather
        gather_from = defaultdict(list)
        for oid, o in objects.items():
            if o.get("gather"):
                gather_from[o["gather"]].append({"t": "object", "id": oid})
            for s in o.get("stateGathers", []):
                gather_from[s["gather"]].append({"t": "object", "id": oid, "state": s["state"]})
        for iid, it in items.items():
            for key in ("butcher", "essence"):
                if it.get(key):
                    gather_from[it[key]].append({"t": "item", "id": iid, "via": key})
        for mid, m in mobs.items():
            g = objects.get(m.get("corpse"), {}).get("gather")
            if g:
                m["butcher"] = g
                gather_from[g].append({"t": "mob", "id": mid})
        for gid, g in self.gathers.items():
            g["from"] = gather_from.get(gid, [])
            for x in g.get("items", []):
                src(x["item"], "gather", compact({"gather": gid, "chance": x.get("chance"), "min": x.get("min"), "max": x.get("max")}))
            for n in g.get("needs", []):
                use(n["item"], "gather", gid)

        # npcs
        for nid, n in self.npcs.items():
            for s in n.get("shop", []):
                src(s["item"], "shop", compact({"npc": nid, "price": s.get("price"), "currency": s.get("currency"), "book": s.get("book")}))
                if s.get("currency"):
                    use(s["currency"], "currency", nid)
            for iid in n.get("buys", {}).get("items", []):
                use(iid, "buyer", nid)

        # quests
        for qid, q in self.quests.items():
            r = q.get("reward", {})
            if r.get("item"):
                src(r["item"], "quest", qid)
            for k, v in q.get("goal", {}).items():
                for target in v if isinstance(v, list) else [v]:
                    if not isinstance(target, dict) or "t" not in target:
                        continue
                    if target["t"] == "item":
                        use(target["id"], "quest", qid)
                    elif target["t"] == "mob" and target["id"] in mobs:
                        lst = mobs[target["id"]].setdefault("quests", [])
                        if qid not in lst:
                            lst.append(qid)
            for role in ("giver", "taker"):
                if q.get(role) in self.npcs:
                    lst = self.npcs[q[role]].setdefault("quests", [])
                    if qid not in lst:
                        lst.append(qid)

        # spawns
        for aid, a in self.areas.items():
            for s in a.get("spawns", []):
                target = {"mob": mobs, "npc": self.npcs, "object": objects}.get(s["t"], {}).get(s["id"])
                if target is not None:
                    target.setdefault("areas", []).append(compact({"area": aid, "event": s.get("event")}))

        # pets / fishing / item groups / seeds
        for mid, m in mobs.items():
            if m.get("pet"):
                src(m["pet"], "catch", mid)
        for fid, f in self.fishing["fish"].items():
            for iid in f.get("items", []):
                src(iid, "fishing", fid)
            for b in f.get("baits", []):
                use(b, "bait", fid)
        for iid, it in items.items():
            for member in it.get("group", []):
                use(member, "group", iid)
            if it.get("oathVariant"):
                src(it["oathVariant"], "oath", iid)
            if it.get("ammo"):
                for member in items.get(it["ammo"], {}).get("group", []):
                    use(member, "ammoFor", iid)
        for n, d in self.by_cls["WTScriptablePlant"].items():
            for s in d.get("sproutsForSeeds", []):
                seed = self.ref(s.get("seed"))
                for sp in s.get("sprouts", []):
                    crop = self.ref(sp.get("worldType"))
                    if seed and crop:
                        use(seed, "plant", crop)
                        if crop in objects:
                            objects[crop].setdefault("seeds", []).append(compact({"item": seed, "chance": num(sp.get("chance")), "level": sp.get("skillLevel")}))

    # ---- locales ----------------------------------------------------------------------

    def locales(self) -> dict[str, dict[str, str]]:
        out = {}
        for name, text in self.texts.items():
            if len(text) < 50_000 or '"UI.LoginWindow' not in text[:2000]:
                continue
            data = loads_lenient(text)
            out[name] = {k: v for k, v in sorted(data.items()) if k.startswith(LOCALE_PREFIXES) and v}
        return out


def weighted(rows) -> list[dict]:
    """Collapse repeated randomList rows (the game's way of weighting) into ``w``."""
    out = {}
    for r in rows:
        key = tuple(sorted(r.items()))
        if key in out:
            out[key]["w"] = out[key].get("w", 1) + 1
        else:
            out[key] = dict(r)
    return list(out.values())


def loot_chances(table) -> dict[str, dict]:
    """Per item: chance to get at least one, and the amount range."""
    out = {}
    for e in table.get("entries", []):
        n = e.get("n") or 1
        for r in e.get("items", []):
            p = e.get("chance", 1) * r.get("w", 1) / n
            cur = out.setdefault(r["item"], {"miss": 1.0, "min": None, "max": None})
            cur["miss"] *= 1 - p
            lo, hi = r.get("min"), r.get("max") or r.get("min")
            if lo is not None:
                cur["min"] = lo if cur["min"] is None else min(cur["min"], lo)
            if hi is not None:
                cur["max"] = hi if cur["max"] is None else max(cur["max"], hi)
    return {
        k: compact({"chance": num(round(1 - v["miss"], 6)), "min": v["min"], "max": v["max"]})
        for k, v in out.items()
    }
