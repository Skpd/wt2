"""Low-level access to Wild Terra 2's Unity data files.

Everything the wiki needs lives in ``resources.assets``:

* ScriptableObjects (MonoBehaviours without a GameObject) for items, mobs,
  quests, ... The build ships without type trees, so they are generated from
  the game's ``Managed/*.dll`` with TypeTreeGeneratorAPI.
* JSON TextAssets: ``drop``, ``craft``, ``build``, ``gift``, locales, ...
* Sprites for icons.
"""

from __future__ import annotations

import json
import logging
import pickle
import re
import struct
from pathlib import Path

import UnityPy
import UnityPy.helpers.TypeTreeHelper as TypeTreeHelper
from UnityPy.helpers.TypeTreeGenerator import TypeTreeGenerator

log = logging.getLogger(__name__)

ASSEMBLY = "Assembly-CSharp"
CACHE_VERSION = 1
_BOOST_READER = TypeTreeHelper.read_typetree_boost


def fix_nodes(node, root=True):
    """Patch generator output so UnityPy can read it.

    TypeTreeGeneratorAPI labels list fields with their element type instead
    of ``vector`` (e.g. ``string craftSpecialSkills`` for ``List<string>``),
    which makes UnityPy read a single value and run off the rails.
    """
    children = node.m_Children or []
    if (
        not root
        and len(children) == 1
        and children[0].m_Type == "Array"
        and node.m_Type not in ("vector", "map", "staticvector")
    ):
        data = children[0].m_Children[-1]
        if not (node.m_Type == "string" and data.m_Type == "char"):
            node.m_Type = "vector"
    for child in children:
        fix_nodes(child, False)
    return node


def loads_lenient(text: str):
    """json.loads that tolerates a BOM, // and /* */ comments, and trailing commas."""
    text = text.lstrip("﻿")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    out, i, n = [], 0, len(text)
    while i < n:
        c = text[i]
        if c == '"':
            j = i + 1
            while j < n and text[j] != '"':
                j += 2 if text[j] == "\\" else 1
            out.append(text[i : j + 1])
            i = j + 1
        elif text.startswith("//", i):
            while i < n and text[i] != "\n":
                i += 1
        elif text.startswith("/*", i):
            i = text.find("*/", i + 2) + 2
        else:
            out.append(c)
            i += 1
    return json.loads(re.sub(r",(\s*[}\]])", r"\1", "".join(out)))


class Game:
    def __init__(self, data_dir: Path, cache_dir: Path | None = None):
        self.data_dir = Path(data_dir)
        self.cache_dir = cache_dir
        resources = self.data_dir / "resources.assets"
        log.info("loading %s", resources)
        self.env = UnityPy.load(str(resources))
        self.file = next(iter(self.env.files.values()))
        self.objects = self.file.objects
        self.unity_version = self.file.unity_version
        self._externals = [None] + [e.path for e in self.file.externals]
        self._scripts = self._load_script_names()
        self._generator = None
        self._nodes = {}
        self._prefabs = {}
        self._so = None

    # ---- scripts / type trees -------------------------------------------

    def _load_script_names(self) -> dict[int, str]:
        env = UnityPy.load(str(self.data_dir / "globalgamemanagers.assets"))
        return {
            o.path_id: o.read().m_ClassName
            for o in env.objects
            if o.type.name == "MonoScript"
        }

    @property
    def generator(self) -> TypeTreeGenerator:
        if self._generator is None:
            log.info("generating type trees from Managed/")
            self._generator = TypeTreeGenerator(self.unity_version)
            self._generator.load_local_dll_folder(str(self.data_dir / "Managed"))
        return self._generator

    def nodes(self, cls: str):
        if cls not in self._nodes:
            self._nodes[cls] = fix_nodes(self.generator.get_nodes_up(ASSEMBLY, cls))
        return self._nodes[cls]

    def mono_header(self, obj) -> tuple[int, str | None, str]:
        """(GameObject path id, script class, m_Name) without a full parse."""
        raw = obj.get_raw_data()
        go_pid = struct.unpack_from("<q", raw, 4)[0]
        fid, pid = struct.unpack_from("<iq", raw, 16)
        cls = None
        ext = self._externals[fid] if 0 < fid < len(self._externals) else None
        if ext and ext.endswith("globalgamemanagers.assets"):
            cls = self._scripts.get(pid)
        n = struct.unpack_from("<i", raw, 28)[0]
        name = raw[32 : 32 + n].decode("utf-8", "replace") if 0 <= n < 1024 else ""
        return go_pid, cls, name

    def parse_mono(self, obj, cls: str) -> dict:
        nodes = self.nodes(cls)
        try:
            TypeTreeHelper.read_typetree_boost = _BOOST_READER
            return obj.read_typetree(nodes=nodes)
        except Exception:
            # The C reader still chokes on some patched vectors; the
            # pure-Python reader handles them.
            TypeTreeHelper.read_typetree_boost = None
            try:
                return obj.read_typetree(nodes=nodes)
            finally:
                TypeTreeHelper.read_typetree_boost = _BOOST_READER

    # ---- scriptable objects ---------------------------------------------

    def scriptable_objects(self) -> dict[int, tuple[str, dict]]:
        """All game-data ScriptableObjects: path id -> (class, fields)."""
        if self._so is not None:
            return self._so
        cache = self._cache_path()
        if cache and cache.exists():
            log.info("using cached ScriptableObjects %s", cache.name)
            self._so = pickle.loads(cache.read_bytes())
            return self._so
        log.info("parsing ScriptableObjects (takes a minute or two)")
        result, failed = {}, 0
        for obj in self.objects.values():
            if obj.type.name != "MonoBehaviour":
                continue
            go_pid, cls, _ = self.mono_header(obj)
            if go_pid != 0 or not cls or not cls.startswith("WT"):
                continue
            try:
                result[obj.path_id] = (cls, self.parse_mono(obj, cls))
            except Exception as e:  # keep going, report at the end
                failed += 1
                log.warning("failed to parse %s %s: %s", cls, obj.path_id, e)
        log.info("parsed %d ScriptableObjects (%d failed)", len(result), failed)
        if cache:
            cache.parent.mkdir(parents=True, exist_ok=True)
            cache.write_bytes(pickle.dumps(result))
        self._so = result
        return result

    def _cache_path(self) -> Path | None:
        if not self.cache_dir:
            return None
        st = (self.data_dir / "resources.assets").stat()
        dll = (self.data_dir / "Managed" / "Assembly-CSharp.dll").stat()
        key = f"{CACHE_VERSION}-{st.st_size}-{int(st.st_mtime)}-{dll.st_size}"
        return Path(self.cache_dir) / f"so-{key}.pkl"

    # ---- prefabs ----------------------------------------------------------

    def prefab(self, pid: int) -> dict:
        """Summarise a prefab GameObject: name plus the entity/world type it spawns."""
        if pid in self._prefabs:
            return self._prefabs[pid]
        info = {}
        obj = self.objects.get(pid)
        if obj is not None and obj.type.name == "MonoBehaviour":
            # References to a component (e.g. a quest's WTMob killTarget).
            obj = self.objects.get(self.mono_header(obj)[0])
        if obj is not None and obj.type.name == "GameObject":
            go = obj.read_typetree()
            info["name"] = go["m_Name"]
            for comp in go["m_Component"]:
                c = self.objects.get(comp["component"]["m_PathID"])
                if c is None or c.type.name != "MonoBehaviour":
                    continue
                _, cls, _ = self.mono_header(c)
                if cls in ("WTMob", "WTNpc", "WTPet"):
                    d = self.parse_mono(c, cls)
                    info["entityType"] = d.get("entityType", {}).get("m_PathID", 0)
                    info["xp"] = d.get("rewardExperience", 0)
                    info["skillXp"] = d.get("rewardSkillExperience", 0)
                elif cls == "WTObject":
                    d = self.parse_mono(c, cls)
                    info["worldType"] = d.get("worldType", {}).get("m_PathID", 0)
        self._prefabs[pid] = info
        return info

    # ---- text assets / sprites ------------------------------------------

    def text_assets(self) -> dict[str, str]:
        out = {}
        for obj in self.objects.values():
            if obj.type.name != "TextAsset":
                continue
            t = obj.read()
            s = t.m_Script
            if isinstance(s, bytes):
                s = s.decode("utf-8", "replace")
            out.setdefault(t.m_Name, s)
        return out

    def sprite_image(self, pid: int):
        """(sprite name, PIL image) for a Sprite path id, or None."""
        obj = self.objects.get(pid)
        if obj is None or obj.type.name != "Sprite":
            return None
        sprite = obj.read()
        return sprite.m_Name, sprite.image

    # ---- misc metadata ----------------------------------------------------

    def enums(self) -> dict[str, dict[str, int]]:
        """Enum names/values from Assembly-CSharp.dll metadata."""
        import dnfile

        pe = dnfile.dnPE(str(self.data_dir / "Managed" / f"{ASSEMBLY}.dll"))
        md = pe.net.mdtables
        consts = {}
        for c in md.Constant:
            if c.Parent.table and c.Parent.table.name == "Field":
                v = c.Value
                v = getattr(v, "value", v)
                if isinstance(v, (bytes, bytearray)):
                    v = int.from_bytes(v, "little", signed=True)
                consts[c.Parent.row_index] = v
        enums = {}
        for t in md.TypeDef:
            try:
                base = str(t.Extends.row.TypeName) if t.Extends and t.Extends.row else None
            except Exception:
                base = None
            if base != "Enum":
                continue
            enums[str(t.TypeName)] = {
                str(f.row.Name): consts.get(f.row_index)
                for f in t.FieldList
                if str(f.row.Name) != "value__"
            }
        return enums

    def steam_build(self) -> dict:
        """Steam app/build id from the appmanifest next to the install, if found."""
        steamapps = self.data_dir.parent.parent.parent
        install = self.data_dir.parent.name
        for acf in steamapps.glob("appmanifest_*.acf"):
            fields = dict(re.findall(r'"(\w+)"\s+"([^"]*)"', acf.read_text(errors="replace")))
            if fields.get("installdir") != install:
                continue
            return {
                "appid": fields.get("appid"),
                "buildid": fields.get("buildid"),
                "name": fields.get("name"),
                "updated": int(fields.get("LastUpdated", 0)),
            }
        return {}
