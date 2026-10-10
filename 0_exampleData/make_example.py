"""Generates a fictional, Indy-style example excavation for the GraphExplorer:
three sondages in the Danube floodplain of the Vienna Prater.

Everything here is invented: sites, people, units, finds, dates and
coordinates. The structure follows a real OntoCartographer Studio export
(CIDOC CRM + CRMarchaeo + CRMsci), so every tab of the Explorer has
something to show.

Unlike a random generator, this one *simulates* each sondage: the units are
laid down, cut and eroded one event after the other (oldest first), in a 3D
model. Everything else is read off that one model, so it all agrees:

- the plan polygons ("Geometry") are the footprints of the 3D bodies,
- the elevations are the bodies' highest and lowest points,
- "lies above" / "lies below" are the contacts between the bodies and what
  each cut cuts through (plus the floors that abut a wall), reduced to the
  direct relations as in a Harris matrix,
- every find spot lies inside the body of its unit.

Outputs, all from the same model:

- <out>.json  graph JSON for the Explorer (WGS84, EPSG:4326)
- <out>.obj   3D bodies for Blender, object name = node label (+ .mtl)
- <out>.gpkg  plans, sondages and find spots for QGIS in UTM 33N
              (EPSG:32633), only if GDAL's Python bindings are present
              (e.g. QGIS's own Python)

Needs numpy, shapely and pyproj; takes a minute or two. Usage:

    python make_example.py <out.json>

QGIS's Python has all of it, GDAL included (on Windows, with your version):

    "C:\\Program Files\\QGIS 3.44.4\\bin\\python-qgis.bat" make_example.py GraphExplorer_Example.json
"""
import json
import math
import os
import random
import sys

import numpy as np
import shapely
from pyproj import Transformer
from shapely import set_precision
from shapely.geometry import MultiPolygon, Polygon
from shapely.ops import unary_union

random.seed(1936)
RNG = np.random.default_rng(1936)

CRM = 'http://www.cidoc-crm.org/cidoc-crm/'
ARC = 'http://www.cidoc-crm.org/extensions/crmarchaeo/'
SCI = 'http://www.cidoc-crm.org/extensions/crmsci/'
EX = 'http://example.org/example-indy-style/'
VOC = 'http://example.org/vocabs/'

# --- node types ----------------------------------------------------------
T = {
    'site': CRM + 'E27_Site',
    'ident': CRM + 'E42_Identifier',
    'excav': ARC + 'A9_Archaeological_Excavation',
    'person': CRM + 'E21_Person',
    'sondage': SCI + 'S20_Rigid_Physical_Feature#as:sondage',
    'su': ARC + 'A8_Stratigraphic_Unit#as:stratigraphic_unit',
    'interp': CRM + 'E55_Type#as:interpretation',
    'find': CRM + 'E19_Physical_Object#as:find',
    'otype': CRM + 'E55_Type#as:object_type',
    'material': CRM + 'E57_Material',
    'prod': CRM + 'E12_Production',
}
BROWN, BLUE, PINK, YELLOW, ORANGE = '#c78e66', '#82ddff', '#ffbdca', '#fef3ba', '#fab565'
TYPE_INFO = {  # key: (colour, label en, label de)
    'site': (BROWN, 'Site', 'Gelände'),
    'ident': (YELLOW, 'Identifier', 'Kennung'),
    'excav': (BLUE, 'Archaeological Excavation', 'Ausgrabung'),
    'person': (PINK, 'Person', 'Person'),
    'sondage': (BROWN, 'Sondage', 'Sondage'),
    'su': (BROWN, 'Stratigraphic Unit', 'Stratigrafische Einheit'),
    'interp': (ORANGE, 'Interpretation', 'Interpretation'),
    'find': (BROWN, 'Find', 'Fund'),
    'otype': (ORANGE, 'Object Type', 'Objekttyp'),
    'material': (ORANGE, 'Material', 'Material'),
    'prod': (BLUE, 'Production', 'Herstellung'),
}

# --- edge types: key -> (forward uri, inverse uri, label, inverse label) --
AP11 = ARC + 'AP11_has_physical_relation_to'
E = {
    'composed': (CRM + 'P46_is_composed_of', CRM + 'P46i_forms_part_of', 'is composed of', 'forms part of'),
    'ident': (CRM + 'P48_has_preferred_identifier', CRM + 'P48i_is_preferred_identifier_of', 'has identifier', 'is identifier of'),
    'investigated_by': (ARC + 'AP3i_was_investigated_by', ARC + 'AP3_investigated', 'was investigated by', 'investigated'),
    'carried_out_by': (CRM + 'P14_carried_out_by', CRM + 'P14i_performed', 'carried out by', 'performed'),
    'interp': (CRM + 'P2_has_type#as:has_interpretation', 'is the interpretation of', 'has interpretation', 'is the interpretation of'),
    'contains_find': (CRM + 'P46_is_composed_of#as:contains_find', CRM + 'P46i_forms_part_of#as:was_found_in', 'contains find', 'was found in'),
    'otype': (CRM + 'P2_has_type', CRM + 'P2i_is_type_of', 'has type', 'is type of'),
    'material': (CRM + 'P45_consists_of', CRM + 'P45i_is_incorporated_in', 'consists of', 'is material of'),
    'produced_by': (CRM + 'P108i_was_produced_by', CRM + 'P108_has_produced', 'was produced by', 'produced'),
}
DOT1 = {  # value -> label
    'above': 'lies above', 'below': 'lies below',
    'contemporary with': 'is contemporary with', 'equals': 'equals',
}

nodes = {}
edge_labels = {}


def node(key, nid, label, attrs=None, label_de=None):
    nodes[nid] = {'l': label, 't': T[key], 'a': attrs or {}, 'o': {}, 'i': {}}
    if label_de and label_de != label:
        nodes[nid]['l_i18n'] = {'de': label_de}
    return nid


def link(src, key, dst):
    fwd, inv, lf, li = E[key]
    nodes[src]['o'].setdefault(fwd, []).append(dst)
    nodes[dst]['i'].setdefault(inv, []).append(src)
    edge_labels[fwd] = lf
    edge_labels[inv] = li


def strat(a, value, b):
    """a <value> b, written on both ends (the Studio writes both statements)."""
    back = {'above': 'below', 'below': 'above'}.get(value, value)
    for s, v, d in ((a, value, b), (b, back, a)):
        k = AP11 + '#dot1:' + v
        nodes[s]['o'].setdefault(k, []).append(d)
        nodes[d]['i'].setdefault(k, []).append(s)
        edge_labels[k] = DOT1[v]


# --- geography: the Prater in Vienna, by the Heustadlwasser --------------
# (Austria has detailed background maps -- basemap.at -- to show the map off.)
# The model works in metres in UTM zone 33N; the graph gets WGS84, the
# GeoPackage UTM, Blender metres east/north of the origin below.
LON0, LAT0 = 16.415999, 48.202946
UTM = 'EPSG:32633'
_to_utm = Transformer.from_crs('EPSG:4326', UTM, always_xy=True)
_to_wgs = Transformer.from_crs(UTM, 'EPSG:4326', always_xy=True)
E0, N0 = (round(v) for v in _to_utm.transform(LON0, LAT0))  # whole metres: easy to type into Blender


def to_wgs(e, n):
    """Metres east/north of (E0, N0) -> lon, lat."""
    return _to_wgs.transform(E0 + np.asarray(e), N0 + np.asarray(n))


def wkt_ring(coords):
    return '(' + ', '.join(f'{lo:.7f} {la:.7f}' for lo, la in coords) + ')'


def wkt_polygon_wgs(geom):
    """A shapely (Multi)Polygon in site metres -> WKT in WGS84, 7 decimals (~1 cm).
    Snapped to that grid with set_precision, which keeps it valid: plain rounding
    can fold a hairline sliver at a wall face over itself."""
    geom = shapely.transform(geom, lambda xy: np.column_stack(to_wgs(xy[:, 0], xy[:, 1])))
    geom = set_precision(geom, 1e-7)
    if isinstance(geom, MultiPolygon) and len(geom.geoms) == 1:
        geom = geom.geoms[0]
    assert geom.is_valid and isinstance(geom, (Polygon, MultiPolygon)), geom.geom_type

    def ring(r):
        return wkt_ring(r.coords)

    def poly(p):
        return '(' + ', '.join(ring(r) for r in [p.exterior, *p.interiors]) + ')'
    if isinstance(geom, Polygon):
        return 'POLYGON ' + poly(geom)
    return 'MULTIPOLYGON (' + ', '.join(poly(p) for p in geom.geoms) + ')'


# --- vocabularies --------------------------------------------------------
INTERP = {  # id: (en, de)
    'flood_deposit': ('Flood deposit', 'Hochwassersediment'),
    'looting_pit_fill': ("Backfill of a treasure hunters' pit", 'Verfüllung einer Schatzgräbergrube'),
    'looting_pit_cut': ("Cut of a treasure hunters' pit", 'Eingrabung einer Schatzgräbergrube'),
    'collapse_wall': ('Wall collapse', 'Mauerversturz'),
    'destruction_burning': ('Destruction layer with traces of burning', 'Zerstörungsschicht mit Brandspuren'),
    'floor': ('Floor', 'Fußboden'),
    'use_horizont': ('Use horizon in front of a structure', 'Nutzungshorizont vor einem Gebäude'),
    'pit_cut': ('Cut of a pit', 'Eingrabung einer Grube'),
    'pit_fill': ('Pit fill', 'Grubenverfüllung'),
    'wall_foundation': ('Wall foundation', 'Mauerfundament'),
    'construction_fill': ('Levelling layer', 'Planierschicht'),
    'well_cut': ('Cut of a well shaft', 'Eingrabung eines Brunnenschachts'),
    'well_fill': ('Well fill', 'Brunnenverfüllung'),
    'natural_gravel': ('Natural Danube gravel', 'Anstehender Donauschotter'),
}
CUTS = {'looting_pit_cut', 'pit_cut', 'well_cut'}  # interfaces: no volume, no finds
OTYPES = {
    'sherd': ('Sherd', 'Scherbe'), 'oil_lamp': ('Oil lamp', 'Öllampe'), 'coin': ('Coin', 'Münze'),
    'amulet': ('Amulet', 'Amulett'), 'bead': ('Bead', 'Perle'), 'statuette': ('Statuette', 'Statuette'),
    'arrowhead': ('Arrowhead', 'Pfeilspitze'), 'nail': ('Nail', 'Nagel'), 'fibula': ('Brooch', 'Fibel'),
    'ring': ('Ring', 'Ring'), 'vessel': ('Vessel', 'Gefäß'), 'clay_pipe': ('Clay pipe', 'Tonpfeife'),
    'musket_ball': ('Musket ball', 'Musketenkugel'), 'tablet': ('Tablet', 'Täfelchen'),
    'whip': ('Whip', 'Peitsche'), 'medallion': ('Medallion', 'Medaillon'), 'idol': ('Idol', 'Idol'),
}
MATERIALS = {
    'ceramic': ('Ceramic', 'Keramik'), 'terracotta': ('Terracotta', 'Terrakotta'), 'bronze': ('Bronze', 'Bronze'),
    'gold': ('Gold', 'Gold'), 'silver': ('Silver', 'Silber'), 'iron': ('Iron', 'Eisen'), 'glass': ('Glass', 'Glas'),
    'amber': ('Amber', 'Bernstein'), 'bone': ('Bone', 'Knochen'), 'stone': ('Stone', 'Stein'),
    'lead': ('Lead', 'Blei'), 'leather': ('Leather', 'Leder'),
}
# which materials an object type comes in (weighted)
TYPE_MATERIAL = {
    'sherd': {'ceramic': 1}, 'oil_lamp': {'ceramic': 4, 'bronze': 1}, 'coin': {'bronze': 5, 'silver': 2, 'gold': 1},
    'amulet': {'bronze': 2, 'amber': 2, 'bone': 1, 'gold': 1}, 'bead': {'glass': 3, 'amber': 3, 'stone': 1},
    'statuette': {'terracotta': 3, 'bronze': 2}, 'arrowhead': {'bronze': 2, 'iron': 3},
    'nail': {'iron': 4, 'bronze': 1}, 'fibula': {'bronze': 4, 'iron': 2, 'silver': 1},
    'ring': {'bronze': 3, 'silver': 1, 'gold': 1}, 'vessel': {'ceramic': 5, 'glass': 2, 'bronze': 1},
    'clay_pipe': {'ceramic': 1}, 'musket_ball': {'lead': 1},
}
NOT_YET = {'iron', 'glass'}  # not before the Iron Age (here, at least)
# Periods of the Vienna region, youngest first. Each: (name, from, to, object types with weights)
PERIODS = {p[0]: p for p in [
    ('Modern', 1800, 1989, {'sherd': 3, 'nail': 3, 'coin': 2, 'clay_pipe': 1}),
    ('Early Modern', 1500, 1800, {'sherd': 5, 'clay_pipe': 3, 'coin': 2, 'musket_ball': 2, 'nail': 2}),
    ('Middle Ages', 800, 1500, {'sherd': 6, 'coin': 2, 'nail': 2, 'arrowhead': 1, 'ring': 1, 'vessel': 1}),
    ('Migration Period', 433, 800, {'sherd': 5, 'bead': 3, 'fibula': 2, 'arrowhead': 2, 'ring': 1}),
    ('Late Roman', 250, 433, {'sherd': 6, 'coin': 3, 'oil_lamp': 2, 'nail': 2, 'fibula': 1, 'vessel': 1}),
    ('Early Roman', -15, 250, {'sherd': 6, 'coin': 3, 'oil_lamp': 2, 'fibula': 2, 'statuette': 1, 'nail': 1}),
    ('Iron Age', -800, -15, {'sherd': 5, 'fibula': 3, 'bead': 2, 'ring': 1, 'amulet': 1}),
    ('Late Bronze Age', -1300, -800, {'sherd': 5, 'bead': 2, 'ring': 2, 'arrowhead': 1, 'amulet': 1, 'vessel': 1}),
]}
AGE = {name: i for i, name in enumerate(reversed(list(PERIODS)))}
PRESERVATION = ['complete', 'almost complete', 'fragmented', 'fragmented', 'heavily fragmented']

for vid, (en, de) in INTERP.items():
    node('interp', VOC + vid, en, label_de=de)
for vid, (en, de) in OTYPES.items():
    node('otype', VOC + vid, en, label_de=de)
for vid, (en, de) in MATERIALS.items():
    node('material', VOC + vid, en, label_de=de)


# =========================================================================
# The 3D model
# =========================================================================
# Each sondage is a grid of points (RES apart), split into triangles, and a
# list of events, oldest first. A deposit raises the ground to an upper
# limit (an absolute elevation per grid point; where the limit is below the
# ground, the unit is absent there). A cut -- or erosion -- lowers
# everything to a bowl. Between grid points every limit and bowl is linear.
#
# The meshes replay the same events inside every triangle, exactly: each
# max() and min() splits the triangle along the line where its two sides are
# equal, so a unit's edge runs where it really thins out to nothing, not
# along the grid. Every point's column is then cut into intervals, one per
# unit and in order, so the bodies neither overlap nor leave gaps, and a
# buried pit edge does not show through the layers above it.

RES = 0.2  # m. Wall faces sit half-way between grid points: see wall().


def smooth_noise(X, Y, amp, waves=4, length=(2.5, 7.0)):
    """A few random plane waves: gentle, deterministic undulation, rms ~ amp."""
    z = np.zeros_like(X)
    for _ in range(waves):
        k = 2 * math.pi / RNG.uniform(*length)
        a, ph = RNG.uniform(0, 2 * math.pi, 2)
        z += np.sin(k * (X * math.cos(a) + Y * math.sin(a)) + ph)
    return amp * z / math.sqrt(waves / 2)


def sd_rect(X, Y, x0, y0, x1, y1):
    """Signed distance to an axis-parallel rectangle, negative inside."""
    dx = np.maximum(x0 - X, X - x1)
    dy = np.maximum(y0 - Y, Y - y1)
    return np.hypot(np.maximum(dx, 0), np.maximum(dy, 0)) + np.minimum(np.maximum(dx, dy), 0)


def shoelace(pts):
    """Area of a polygon given as an (m, 2) array."""
    x, y = pts[:, 0], pts[:, 1]
    return 0.5 * abs(np.sum(x * np.roll(y, -1) - np.roll(x, -1) * y))


class Sondage:
    def __init__(self, w, h):
        self.w, self.h = w, h
        self.nx, self.ny = int(round(w / RES)) + 1, int(round(h / RES)) + 1
        self.X, self.Y = np.meshgrid(np.linspace(0, w, self.nx), np.linspace(0, h, self.ny))
        self.bottom = None
        self.events = []          # {'kind': 'dep'|'fill'|'cut'|'erode', 'su', 'f': limit or bowl per grid point}
        self.entries = []         # the events that are units (deposits and cuts), in order
        self.Z = []               # boundaries per grid point: the bottom, then each deposit's top
        self.split = None         # per grid point: may the triangles at it need splitting?
        self.cut_through = set()  # (cut, unit it cut into)

    def surface(self):
        if not self.Z:
            self.Z = [self.bottom.astype(float)]
            self.split = np.zeros(self.X.shape, bool)
        return self.Z[-1].copy()

    def _mark(self, f):
        """Remember where a linear function changes sign between neighbouring grid points."""
        pos = f > 0
        m = np.zeros_like(pos)
        for a, b in ((np.s_[:, 1:], np.s_[:, :-1]), (np.s_[1:, :], np.s_[:-1, :]),
                     (np.s_[1:, 1:], np.s_[:-1, :-1])):
            d = pos[a] != pos[b]
            m[a] |= d
            m[b] |= d
        self.split |= m

    # -- events -------------------------------------------------------------
    def deposit(self, su, thickness=None, top=None, inside=None, taper=20.0):
        """Lay down a unit: a thickness, or everything up to a top surface.
        `inside` (a signed distance, negative inside) confines it; `taper`
        is how many metres of thickness it may gain per metre from that edge."""
        h = self.surface()
        s = thickness if thickness is not None else top - h
        if inside is not None:
            s = np.minimum(s, -inside * taper)
        limit = h + np.asarray(s, float)
        self._mark(limit - h)
        e = {'kind': 'dep', 'su': su, 'f': limit, 'lo': len(self.Z) - 1, 'hi': len(self.Z)}
        self.Z.append(np.maximum(h, limit))
        self.events.append(e)
        self.entries.append(e)

    def remove_down_to(self, bowl, su=None):
        """Take away everything above `bowl`. With a unit id it is a cut
        (a pit, a shaft), without one it is erosion. `bowl` must be finite: it is interpolated."""
        before = self.surface()
        for z in self.Z:
            self._mark(bowl - z)
        for e in self.entries:
            if e['kind'] == 'cut':
                e['depth'] = np.minimum(e['depth'], bowl - self.Z[e['at']])
            elif su:
                # A cut is later than everything it cuts into, even a thin layer it
                # only crosses on a steep side, where no grid point sees the contact.
                was = self.Z[e['hi']] - self.Z[e['lo']]
                now = np.minimum(self.Z[e['hi']], bowl) - np.minimum(self.Z[e['lo']], bowl)
                if np.sum((was > 0.005) & (now < was - 0.005)) >= 2:
                    self.cut_through.add((su, e['su']))
        self.Z = [np.minimum(z, bowl) for z in self.Z]
        e = {'kind': 'cut' if su else 'erode', 'su': su, 'f': np.asarray(bowl, float)}
        if su:
            e.update(at=len(self.Z) - 1, depth=before - bowl)
            self.entries.append(e)
        self.events.append(e)
        return before

    def pit(self, su, cx, cy, rx, ry, depth, side=0.4):
        """A pit dug from the present surface: flat base, sides `side` metres wide
        (in plan). Outside the rim the value keeps falling, so the edge is sharp."""
        u = (1 - np.hypot((self.X - cx) / rx, (self.Y - cy) / ry)) * min(rx, ry) / side
        t = np.clip(u, 0, 1)
        return self.remove_down_to(self.surface() - depth * np.where(u > 0, t * t * (3 - 2 * t), u), su)

    def fill(self, su):
        """Fill the cut just made, exactly up to its rim: the ground it removed
        comes back, as a new unit. (A deposit "up to the old surface" would
        also run into every hollow nearby, between grid points.)"""
        cut = self.events[-1]
        assert cut['kind'] == 'cut', 'fill() follows its cut'
        h = self.surface()
        e = {'kind': 'fill', 'su': su, 'f': h + np.maximum(cut['depth'], 0), 'lo': len(self.Z) - 1,
             'hi': len(self.Z)}
        self.Z.append(e['f'].copy())
        self.events.append(e)
        self.entries.append(e)

    def decay(self, rect, level):
        """A wall's top crumbles down to `level`. The level holds out to the grid
        points just beyond the faces, so the wall is cut flat right up to them."""
        sd = sd_rect(self.X, self.Y, *rect)
        self.remove_down_to(np.where(sd <= RES, level, self.surface().max() + 1))

    def wall(self, su, rect, height, k=20.0):
        """A wall standing on the present surface. Its faces lie half-way between
        grid points and k*RES/2 >= height, so the zero crossing is exactly the face."""
        self.deposit(su, thickness=np.minimum(height, -sd_rect(self.X, self.Y, *rect) * k))


# -- meshing: the same events, evaluated exactly inside each triangle --------

def _split(cell, f):
    """Cut a convex cell along the zero line of the linear function f (one value
    per corner); every per-corner quantity is interpolated onto the new corners."""
    f = np.where(np.abs(f) < 1e-9, 0, f)  # no hairline slivers from rounding noise
    if (f > 0).all() or (f <= 0).all():
        return [cell]
    W, Z, D = cell
    n = len(f)
    parts = []
    for keep in (True, False):
        ii, jj, tt = [], [], []
        for i in range(n):
            j = (i + 1) % n
            pin = f[i] > 0 if keep else f[i] <= 0
            qin = f[j] > 0 if keep else f[j] <= 0
            if pin:
                ii.append(i), jj.append(j), tt.append(0.0)
            if pin != qin:
                ii.append(i), jj.append(j), tt.append(f[i] / (f[i] - f[j]))
        if len(ii) >= 3:
            t = np.array(tt)[:, None]
            parts.append(tuple(A[ii] + t * (A[jj] - A[ii]) for A in (W, Z, D)))
    return parts


def model_cells(so):
    """Yield (corners xy, boundaries per corner, cut depths per corner) for every
    piece of every triangle. Inside a piece, all of them are linear."""
    cut_events = [e for e in so.events if e['kind'] == 'cut']
    Zf = np.stack(so.Z, -1)                                            # (ny, nx, nb)
    Df = np.stack([e['depth'] for e in cut_events], -1) if cut_events else np.zeros(so.X.shape + (0,))
    for j in range(so.ny - 1):
        for i in range(so.nx - 1):
            corners = [(j, i), (j, i + 1), (j + 1, i + 1), (j + 1, i)]
            for tri in ((corners[0], corners[1], corners[2]), (corners[0], corners[2], corners[3])):
                idx = tuple(np.array(tri).T)
                xy = np.stack([so.X[idx], so.Y[idx]], -1)
                if not so.split[idx].any():                            # nothing changes inside
                    yield xy, Zf[idx], Df[idx]
                    continue
                cells = [(np.eye(3), so.bottom[idx][:, None].astype(float), np.zeros((3, 0)))]
                for e in so.events:
                    fv = e['f'][idx]
                    nxt = []
                    for cell in cells:
                        if e['kind'] == 'dep':
                            for W, Z, D in _split(cell, cell[0] @ fv - cell[1][:, -1]):
                                nxt.append((W, np.hstack([Z, np.maximum(Z[:, -1], W @ fv)[:, None]]), D))
                            continue
                        if e['kind'] == 'fill':  # the cut's depth is still the last column, untouched
                            W, Z, D = cell
                            nxt.append((W, np.hstack([Z, (Z[:, -1] + np.maximum(D[:, -1], 0))[:, None]]), D))
                            continue
                        parts = [cell]
                        for b in range(cell[1].shape[1]):
                            parts = [q for p in parts for q in _split(p, p[0] @ fv - p[1][:, b])]
                        for W, Z, D in parts:
                            bowl = W @ fv
                            ats = [c['at'] for c in cut_events[:D.shape[1]]]
                            D = np.minimum(D, bowl[:, None] - Z[:, ats]) if ats else D
                            if e['kind'] == 'cut':
                                D = np.hstack([D, (Z[:, -1] - bowl)[:, None]])
                            nxt.append((W, np.minimum(Z, bowl[:, None]), D))
                    cells = nxt
                for W, Z, D in cells:
                    pts = W @ xy
                    if shoelace(pts) > 1e-9:
                        yield pts, Z, D


class Mesh:
    def __init__(self):
        self.index, self.verts, self.faces = {}, [], []

    def v(self, p):
        key = tuple(round(c, 5) for c in p)
        if key not in self.index:
            self.index[key] = len(self.verts)
            self.verts.append(key)
        return self.index[key]

    def face(self, pts):
        idx = []
        for p in pts:
            k = self.v(p)
            if k not in idx:
                idx.append(k)
        if len(idx) >= 3:
            self.faces.append(idx)


def build_bodies(so, ox, oy):
    """Meshes (site metres), plan footprints and cells per unit of one sondage."""
    n = len(so.entries)
    cut_col = {id(e): k for k, e in enumerate(e for e in so.events if e['kind'] == 'cut')}
    meshes = [Mesh() for _ in range(n)]
    plans = [[] for _ in range(n)]
    cells = [[] for _ in range(n)]
    eps = 1e-7

    def on_edge(p, q):
        return any(abs(p[a] - v) < eps and abs(q[a] - v) < eps
                   for a, v in ((0, 0), (0, so.w), (1, 0), (1, so.h)))

    for pts, Z, D in model_cells(so):
        g = pts + (ox, oy)
        for k, e in enumerate(so.entries):
            if e['kind'] == 'cut':
                if D[:, cut_col[id(e)]].mean() <= 1e-9:
                    continue
                plans[k].append(Polygon(g))
                meshes[k].face([(x, y, zz) for (x, y), zz in zip(g, Z[:, e['at']])])
                continue
            bot, top = Z[:, e['lo']], Z[:, e['hi']]
            if (top - bot).mean() <= 1e-9:
                continue
            plans[k].append(Polygon(g))
            cells[k].append((g, bot, top))
            meshes[k].face([(x, y, zz) for (x, y), zz in zip(g, top)])
            meshes[k].face([(x, y, zz) for (x, y), zz in reversed(list(zip(g, bot)))])
            m = len(g)
            for a in range(m):  # section faces where the body meets the trench wall
                b = (a + 1) % m
                if on_edge(pts[a], pts[b]):
                    meshes[k].face([(*g[a], bot[a]), (*g[b], bot[b]), (*g[b], top[b]), (*g[a], top[a])])
    out = []
    for k in range(n):
        plan = unary_union(plans[k]) if plans[k] else None
        if plan is not None:
            plan = set_precision(plan.simplify(0.005), 1e-4)
            if isinstance(plan, MultiPolygon) and len(plan.geoms) == 1:
                plan = plan.geoms[0]
            assert isinstance(plan, (Polygon, MultiPolygon)), plan.geom_type
        out.append({'mesh': meshes[k], 'plan': plan, 'cells': cells[k]})
    return out


def contacts(so, min_points=3):
    """Pairs (upper, lower) of units in direct contact, from the grid columns."""
    present = np.stack([(e['depth'] if e['kind'] == 'cut' else so.Z[e['hi']] - so.Z[e['lo']]) > 0.005
                        for e in so.entries])                         # (n, ny, nx)
    count = {}
    for j in range(so.ny):
        for i in range(so.nx):
            stack = [k for k in range(len(so.entries)) if present[k, j, i]]
            for lower, upper in zip(stack, stack[1:]):
                count[(upper, lower)] = count.get((upper, lower), 0) + 1
    return {p for p, c in count.items() if c >= min_points}


# =========================================================================
# The story, one sondage at a time (events oldest first)
# =========================================================================
# The units carry their final numbers: excavators number top-down, as they dig.

def story_tsp_so1(so, z0):
    X, Y = so.X, so.Y
    wall = (6.1, -5, 7.3, so.h + 5)                       # N-S wall, faces between grid points
    room, outside = X - 6.1, 7.3 - X                       # west of the wall / east of it
    bed = z0 - 2.55 - 0.08 * (X / so.w) + smooth_noise(X, Y, 0.07)
    so.bottom = np.full_like(X, bed.min() - 0.3)
    so.deposit('SU1015', top=bed)                                          # Danube gravel
    so.deposit('SU1014', top=z0 - 2.25 + smooth_noise(X, Y, 0.02))         # Roman levelling
    so.wall('SU1013', wall, 1.6)                                           # the sanctuary's wall
    so.deposit('SU1012', top=z0 - 2.05 + smooth_noise(X, Y, 0.01), inside=room)     # its first floor
    so.deposit('SU1011', top=z0 - 2.10 + smooth_noise(X, Y, 0.02), inside=outside)  # and the ground outside
    so.pit('SU1010', 2.6, 3.3, 1.1, 0.9, 0.7, side=0.35)                   # pit for a ritual meal
    so.fill('SU1009')
    so.deposit('SU1008', top=z0 - 1.85 + smooth_noise(X, Y, 0.01), inside=room)     # Late Roman floor
    so.deposit('SU1007', top=z0 - 1.88 + smooth_noise(X, Y, 0.02), inside=outside)  # Late Roman use
    so.deposit('SU1006', thickness=0.16 + smooth_noise(X, Y, 0.04), inside=room)    # the fire
    so.decay(wall, z0 - 1.50)                                              # the wall decays
    near = np.maximum(sd_rect(X, Y, *wall), 0)
    so.deposit('SU1005', top=z0 - 1.35 - 0.12 * near)                      # its collapse
    so.deposit('SU1004', top=z0 - 0.95 + smooth_noise(X, Y, 0.05))         # Danube floods
    so.pit('SU1003', 3.6, 5.7, 1.4, 1.2, 0.95, side=0.45)                  # treasure hunters
    so.fill('SU1002')
    so.deposit('SU1001', top=z0 + smooth_noise(X, Y, 0.04))                # floods until the 1870s, topsoil


def story_tsp_so2(so, z0):
    X, Y = so.X, so.Y
    wall = (-5, 2.7, so.w + 5, 3.7)                        # E-W wall
    room, outside = Y - 2.7, 3.7 - Y                       # south of it / north of it
    bed = z0 - 2.10 + 0.06 * (Y / so.h) + smooth_noise(X, Y, 0.06)
    so.bottom = np.full_like(X, bed.min() - 0.3)
    so.deposit('SU2011', top=bed)
    so.deposit('SU2010', top=z0 - 1.85 + smooth_noise(X, Y, 0.02))         # Late Roman levelling
    so.wall('SU2009', wall, 1.5)                                           # storeroom wall
    so.deposit('SU2008', top=z0 - 1.65 + smooth_noise(X, Y, 0.01), inside=room)
    so.deposit('SU2007', top=z0 - 1.70 + smooth_noise(X, Y, 0.02), inside=outside)
    so.deposit('SU2006', thickness=0.18 + smooth_noise(X, Y, 0.04), inside=room)    # = SU1006
    so.decay(wall, z0 - 1.25)
    near = np.maximum(sd_rect(X, Y, *wall), 0)
    so.deposit('SU2005', top=z0 - 1.05 - 0.12 * near)
    so.deposit('SU2004', top=z0 - 0.75 + smooth_noise(X, Y, 0.05))
    so.pit('SU2003', 5.6, 1.5, 1.0, 0.95, 0.75)                            # rubbish pit, imperial hunting grounds
    so.fill('SU2002')
    so.deposit('SU2001', top=z0 + smooth_noise(X, Y, 0.04))


def story_wos_so1(so, z0):
    X, Y = so.X, so.Y
    shaft = (4.9, 4.9, 7.1, 7.1)
    walls = [(1.5, -5, 2.5, so.h + 5), (9.5, -5, 10.5, so.h + 5)]
    shrine = np.maximum(2.5 - X, X - 9.5)                  # between the walls
    bed = z0 - 2.90 + smooth_noise(X, Y, 0.08)
    shaft_bottom = z0 - 5.0
    so.bottom = np.where(sd_rect(X, Y, *shaft) <= 0, shaft_bottom - 0.3, bed.min() - 0.3)
    so.deposit('SU3014', top=bed)
    s = -sd_rect(X, Y, *shaft) * 25                        # vertical sides, down to the groundwater
    so.remove_down_to(so.surface() - np.minimum(so.surface() - shaft_bottom, s), 'SU3013')
    so.fill('SU3012')                                                      # Bronze Age: the deposit in the Well
    so.deposit('SU3011', top=z0 - 2.55 + smooth_noise(X, Y, 0.02))         # Iron Age: seals the well
    so.wall('SU3010', walls[0], 1.5)
    so.wall('SU3009', walls[1], 1.5)
    so.deposit('SU3008', top=z0 - 2.35 + smooth_noise(X, Y, 0.01), inside=shrine)   # Iron Age floor
    so.deposit('SU3007', top=z0 - 2.15 + smooth_noise(X, Y, 0.01), inside=shrine)   # Roman floor
    so.decay(walls[0], z0 - 1.75)
    so.decay(walls[1], z0 - 1.75)
    wall_sd = np.minimum(sd_rect(X, Y, *walls[0]), sd_rect(X, Y, *walls[1]))
    so.deposit('SU3006', top=z0 - 1.55 - 0.10 * np.maximum(wall_sd, 0))   # collapse
    so.deposit('SU3005', top=z0 - 1.40 + smooth_noise(X, Y, 0.015))        # Migration Period floor
    r = np.hypot((X - 6.0) / 4.0, (Y - 6.5) / 4.6)
    so.deposit('SU3004', thickness=0.15 + smooth_noise(X, Y, 0.03), inside=(r - 1) * 4.0, taper=0.6)
    so.pit('SU3003', 8.6, 8.4, 1.3, 1.25, 1.35, side=0.45)                 # treasure hunters miss the well
    so.fill('SU3002')
    so.deposit('SU3001', top=z0 + smooth_noise(X, Y, 0.04))


# --- what the excavators wrote down about each unit -----------------------
# (interpretation, period or None, description)
UNITS = {
    'SU1001': ('flood_deposit', 'Modern', 'Brown flood loam with the modern topsoil on top; laid down by the Danube floods until the river was regulated in the 1870s'),
    'SU1002': ('looting_pit_fill', 'Early Modern', "Backfill of treasure hunters' pit SU1003: loose mixed loam with rubble, mortar, charcoal and finds of every period"),
    'SU1003': ('looting_pit_cut', None, "Cut of an oval treasure hunters' pit with steep sides; its flat base stops on the mortar floor SU1008"),
    'SU1004': ('flood_deposit', 'Middle Ages', 'Layered grey-brown flood loam and sand, laid down by the Danube while the ruin lay abandoned'),
    'SU1005': ('collapse_wall', 'Migration Period', 'Collapse of wall SU1013: rubble stones and mortar in a brown loamy matrix, thickest beside the wall'),
    'SU1006': ('destruction_burning', 'Late Roman', 'Black ashy silt with charcoal and burnt roof timbers on floor SU1008: the fire that ended the sanctuary, the same as SU2006 in Sondage 2'),
    'SU1007': ('use_horizont', 'Late Roman', 'Trampled use horizon east of wall SU1013: compact grey-brown silt with flat-lying sherds'),
    'SU1008': ('floor', 'Late Roman', 'Mortar floor laid over floor SU1012 and pit fill SU1009; abuts wall SU1013'),
    'SU1009': ('pit_fill', 'Early Roman', 'Fill of pit SU1010: dark ashy loam with animal bones and broken drinking vessels, the remains of a ritual meal'),
    'SU1010': ('pit_cut', None, 'Cut of a bowl-shaped pit, dug through floor SU1012 into the natural gravel'),
    'SU1011': ('use_horizont', 'Early Roman', 'Use horizon in front of wall SU1013: compact grey-brown trampled silt'),
    'SU1012': ('floor', 'Early Roman', 'Beaten-clay floor of the sanctuary west of wall SU1013; abuts the wall'),
    'SU1013': ('wall_foundation', 'Early Roman', 'Wall of rubble stone and lime mortar running north-south, 1.2 m wide; its top collapsed into SU1005'),
    'SU1014': ('construction_fill', 'Early Roman', 'Levelling layer of gravel and brick fragments under the sanctuary'),
    'SU1015': ('natural_gravel', None, 'Natural Danube gravel: sandy, with rounded pebbles'),

    'SU2001': ('flood_deposit', 'Modern', 'Brown flood loam with the modern topsoil on top'),
    'SU2002': ('pit_fill', 'Early Modern', 'Fill of rubbish pit SU2003: dark loam with animal bones, clay pipes and lead shot, waste from the imperial hunting grounds'),
    'SU2003': ('pit_cut', None, 'Cut of a round rubbish pit, dug from the top of flood loam SU2004'),
    'SU2004': ('flood_deposit', 'Middle Ages', 'Layered grey-brown flood loam over the ruin'),
    'SU2005': ('collapse_wall', 'Migration Period', 'Collapse of wall SU2009: rubble stones and mortar, thickest beside the wall'),
    'SU2006': ('destruction_burning', 'Late Roman', 'Black ashy silt with charcoal and burnt storage jars on floor SU2008; the same fire as SU1006 in Sondage 1'),
    'SU2007': ('use_horizont', 'Late Roman', 'Use horizon north of wall SU2009: trampled grey-brown silt'),
    'SU2008': ('floor', 'Late Roman', 'Beaten-clay floor of the storeroom south of wall SU2009; abuts the wall'),
    'SU2009': ('wall_foundation', 'Late Roman', 'Wall of rubble stone and mortar running east-west, 1.0 m wide; its top collapsed into SU2005'),
    'SU2010': ('construction_fill', 'Late Roman', 'Levelling layer of gravel and brick fragments under the storeroom'),
    'SU2011': ('natural_gravel', None, 'Natural Danube gravel: sandy, with rounded pebbles'),

    'SU3001': ('flood_deposit', 'Modern', 'Brown flood loam with topsoil; it covered the site when the excavation began in 1936'),
    'SU3002': ('looting_pit_fill', 'Early Modern', "Backfill of treasure hunters' pit SU3003: loose mixed loam with rubble and residual finds; an Ottoman coin dates it to the siege of 1683"),
    'SU3003': ('looting_pit_cut', None, "Cut of a round treasure hunters' pit; it ends in levelling layer SU3011, an arm's length short of the well SU3013"),
    'SU3004': ('destruction_burning', 'Middle Ages', 'Lens of black ash with burnt wattle on floor SU3005'),
    'SU3005': ('floor', 'Migration Period', 'Beaten-earth floor laid over the levelled collapse SU3006, ignoring the old walls'),
    'SU3006': ('collapse_wall', 'Late Roman', 'Collapse of walls SU3009 and SU3010: stones and loam filling the shrine'),
    'SU3007': ('floor', 'Early Roman', 'Renewed clay floor of the shrine, laid on floor SU3008'),
    'SU3008': ('floor', 'Iron Age', 'Clay floor of the shrine between walls SU3009 and SU3010'),
    'SU3009': ('wall_foundation', 'Iron Age', 'East wall of the shrine: stone footing of a timber-framed wall, 1.0 m wide, running north-south'),
    'SU3010': ('wall_foundation', 'Iron Age', 'West wall of the shrine: stone footing of a timber-framed wall, 1.0 m wide, running north-south'),
    'SU3011': ('construction_fill', 'Iron Age', 'Levelling layer of gravel and loam that seals the well SU3013'),
    'SU3012': ('well_fill', 'Late Bronze Age', 'Clean sand filling the well SU3013, with a great many skeletons of Aesculapian snakes; at its base the golden idol and the headpiece of a staff'),
    'SU3013': ('well_cut', None, 'Square well shaft, 2.2 × 2.2 m, dug 2.1 m deep into the gravel, down to the groundwater: the Well'),
    'SU3014': ('natural_gravel', None, 'Natural Danube gravel: sandy, with rounded pebbles'),
}

# Relations the bodies cannot show by lying on one another: a floor that
# abuts a wall is later than the wall; contemporary units; one context
# recorded twice.
ABUTS = [('SU1012', 'SU1013'), ('SU1011', 'SU1013'), ('SU1008', 'SU1013'), ('SU1007', 'SU1013'),
         ('SU1006', 'SU1013'), ('SU2008', 'SU2009'), ('SU2007', 'SU2009'), ('SU2006', 'SU2009'),
         ('SU3008', 'SU3009'), ('SU3008', 'SU3010'), ('SU3007', 'SU3009'), ('SU3007', 'SU3010')]
CONTEMPORARY = [('SU1012', 'SU1011'), ('SU1008', 'SU1007'), ('SU2008', 'SU2007'), ('SU3010', 'SU3009')]
EQUALS = [('SU1006', 'SU2006')]

# --- sites, people, excavations ------------------------------------------
ws = node('site', EX + 'serpents_meadow', "Serpent's Meadow",
          {'Description': 'Floodplain of a former arm of the Danube, with several sites of different periods'},
          label_de='Schlangenau')
node('ident', EX + 'SA', 'SA'); link(ws, 'ident', EX + 'SA')

people = {
    'jones': node('person', EX + 'person_h_jones', 'Dr. Henry Jones Jr.'),
    'schneider': node('person', EX + 'person_e_schneider', 'Dr. Elsa Schneider'),
    'ravenwood': node('person', EX + 'person_m_ravenwood', 'Marion Ravenwood'),
    'brody': node('person', EX + 'person_m_brody', 'Dr. Marcus Brody'),
}

SITES = [
    # site id, label, description, short, excavation id, excavation label, start, end, directors,
    # origin (m), sondages: (id, label, (x, y, w, h), story, ground level), last year a find can be from
    ('the_secret_place', 'The Secret Place', 'A Roman sanctuary of Mithras and its storeroom', 'TSP', 'secret_place_excavation', 'Excavation of the Secret Place',
     '1981', '1989', ['ravenwood', 'brody'], (0, 0),
     [('SO1', 'Secret Place Sondage 1', (0, 0, 10, 10), story_tsp_so1, 157.20),
      ('SO2', 'Secret Place Sondage 2', (4, 24, 8, 6), story_tsp_so2, 157.35)], 1980),
    ('the_well_of_souls', 'The Well of Souls',
     'A Bronze Age well with a votive deposit, sealed and built over by an Iron Age shrine', 'WOS', 'well_of_souls_excavation', 'Excavation of the Well of Souls',
     '1936', '1938', ['jones', 'schneider'], (16, 4),
     [('SO1', 'Well of Souls Sondage 1', (0, 0, 12, 12), story_wos_so1, 156.80)], 1935),
]

bodies = {}      # SU label -> {'mesh', 'plan', 'cells', 'kind', 'sondage'}
su_node = {}     # SU label -> node id
su_site = {}     # SU label -> (site short, sondage short, last year)
above = set()    # (upper label, lower label)
sondage_plans = {}

for sid, slabel, sdesc, short, xid, xlabel, start, end, directors, (ox, oy), sondages, last_year in SITES:
    site = node('site', EX + sid, slabel, {'Description': sdesc})
    node('ident', EX + short, short); link(site, 'ident', EX + short)
    link(ws, 'composed', site)
    exc = node('excav', EX + xid, xlabel, {'start_date': start, 'end_date': end})
    link(site, 'investigated_by', exc)
    for d in directors:
        link(exc, 'carried_out_by', people[d])

    for so, solabel, (x, y, w, h), story, z0 in sondages:
        x0, y0 = ox + x, oy + y
        outline = Polygon([(x0, y0), (x0 + w, y0), (x0 + w, y0 + h), (x0, y0 + h)])
        so_id = node('sondage', EX + f'{short}-{so}', solabel,
                     {'Geometry': wkt_polygon_wgs(outline), 'Size': f'{w} × {h} m'})
        sondage_plans[so_id] = (solabel, short, outline)
        link(site, 'composed', so_id)
        nodes[exc]['o'].setdefault(E['investigated_by'][1], []).append(so_id)
        nodes[so_id]['i'].setdefault(E['investigated_by'][0], []).append(exc)

        model = Sondage(w, h)
        story(model, z0)
        built = build_bodies(model, x0, y0)
        labels = [e['su'] for e in model.entries]
        for (u, l) in contacts(model):
            above.add((labels[u], labels[l]))
        above |= model.cut_through

        # Number order (top-down) is the order the units are listed in.
        for k in sorted(range(len(labels)), key=lambda k: labels[k]):
            lab = labels[k]
            interp, period, desc = UNITS[lab]
            b = built[k]
            assert b['plan'] is not None and not b['plan'].is_empty, lab
            assert b['plan'].is_valid, lab
            if b['cells']:  # where the body has substance, not where it thins out to nothing
                zs = np.concatenate([np.r_[bot[top - bot > 0.01], top[top - bot > 0.01]]
                                     for g, bot, top in b['cells']])
            else:
                zs = np.array(b['mesh'].verts)[:, 2]
            uid = EX + f'{short}-{so}-{lab}'
            attrs = {
                'Description': desc,
                'Elevation top (m)': f'{zs.max():.2f}',
                'Elevation bottom (m)': f'{zs.min():.2f}',
            }
            if model.entries[k]['kind'] != 'cut':
                vol = sum(shoelace(g) * (np.mean(top) - np.mean(bot)) for g, bot, top in b['cells'])
                attrs['Volume (m³)'] = f'{vol:.2f}'
            if period:
                attrs['Period'] = period
            attrs['Geometry'] = wkt_polygon_wgs(b['plan'])
            node('su', uid, lab, attrs)
            link(so_id, 'composed', uid)
            link(uid, 'interp', VOC + interp)
            bodies[lab] = dict(b, kind=model.entries[k]['kind'], interp=interp, period=period)
            su_node[lab] = uid
            su_site[lab] = (short, f'{short}-{so}', last_year)

# --- stratigraphic relations -----------------------------------------------
# Contacts plus abutments, then only the direct ones: a unit that lies above
# another *through* a third is not recorded (the Harris matrix rule).
rel = above | set(ABUTS)
for a, b in CONTEMPORARY + EQUALS:
    assert (a, b) not in rel and (b, a) not in rel, (a, b)
succ = {}
for a, b in rel:
    succ.setdefault(a, set()).add(b)


def reachable(a, skip_edge):
    seen, todo = set(), [a]
    while todo:
        u = todo.pop()
        for v in succ.get(u, ()):
            if (u, v) == skip_edge or v in seen:
                continue
            seen.add(v)
            todo.append(v)
    return seen


for a, b in sorted(rel):  # cycle check and transitive reduction
    assert a not in reachable(a, None), f'cycle through {a}'
direct = sorted((a, b) for a, b in rel if b not in reachable(a, (a, b)))
for a, b in direct:
    strat(su_node[a], 'above', su_node[b])
for a, b in CONTEMPORARY:
    strat(su_node[a], 'contemporary with', su_node[b])
for a, b in EQUALS:
    strat(su_node[a], 'equals', su_node[b])


# --- finds -----------------------------------------------------------------
def weighted(d):
    items = [(k, v) for k, v in d.items() if v > 0]
    r = random.uniform(0, sum(v for _, v in items))
    for k, v in items:
        r -= v
        if r <= 0:
            return k
    return items[-1][0]


def dating(period, otype):
    _, p0, p1, _ = period
    if otype == 'coin':  # coins date closely
        y = random.randint(p0, p1 - 3)
        return y, y + random.randint(0, 3)
    span = {'sherd': (40, 150), 'oil_lamp': (30, 100), 'statuette': (50, 150)}.get(otype, (25, 200))
    length = random.randint(*span)
    a = random.randint(p0, max(p0, p1 - length))
    return a, min(p1, a + length)


def year(y):
    return f'{-y} BCE' if y < 0 else str(y)


_candidates = {}


def candidates(su, margin=0.25):
    """The unit's cells that can hold a find, their centres and volumes; the
    ones clear of the trench wall flagged (finds are not drawn from the section)."""
    if su not in _candidates:
        cells = [c for c in bodies[su]['cells'] if np.mean(c[2] - c[1]) > 0.04]
        centres = np.array([c[0].mean(0) for c in cells])
        vol = np.array([shoelace(g) * np.mean(top - bot) for g, bot, top in cells])
        x0, y0, x1, y1 = sondage_bounds[su]
        inner = np.array([((g[:, 0] > x0 + margin) & (g[:, 0] < x1 - margin) &
                           (g[:, 1] > y0 + margin) & (g[:, 1] < y1 - margin)).all() for g, _, _ in cells])
        _candidates[su] = (cells, centres, vol if not inner.any() else vol * inner)
    return _candidates[su]


def spot_in(su, near=None, z_rel=None):
    """A point inside the unit's body: a cell weighted by its volume (or the one
    nearest `near`), a random point in it, a height between bottom and top."""
    cells, centres, vol = candidates(su)
    if near is not None:
        k = int(np.argmin(np.hypot(*(centres - near).T)))
    else:
        k = weighted(dict(enumerate(vol)))
    g, bot, top = cells[k]
    # random point in the (convex) cell: fan triangle by area, then barycentric
    tris = [(0, i, i + 1) for i in range(1, len(g) - 1)]
    a, b, c = tris[weighted({i: shoelace(g[list(t)]) for i, t in enumerate(tris)})]
    r1, r2 = random.random(), random.random()
    if r1 + r2 > 1:
        r1, r2 = 1 - r1, 1 - r2
    w = np.array([1 - r1 - r2, r1, r2])
    p = w @ g[[a, b, c]]
    zb, zt = w @ bot[[a, b, c]], w @ top[[a, b, c]]
    f = z_rel if z_rel is not None else random.uniform(.15, .85)
    return p, zb + f * (zt - zb), (zb, zt)


sondage_bounds = {}
for lab, (short, so_short, _) in su_site.items():
    outline = next(o for sid, (_, _, o) in sondage_plans.items() if sid.endswith(so_short))
    sondage_bounds[lab] = outline.bounds

find_count = 0
find_spots = []  # for the 3D export: (label, x, y, z, su)


def add_find(su, num, otype, material, period, desc=None, preservation=None, weight=None,
             dated=True, near=None, z_rel=None):
    global find_count
    find_count += 1
    short, so_short, _ = su_site[su]
    su_num = su[2:]
    inv = f'{short}-{su_num}-{num:02d}'
    fid = EX + f'{so_short}-SU{su_num}-{num:02d}'
    (x, y), z, (zb, zt) = spot_in(su, near, z_rel)
    assert zb - 1e-9 <= z <= zt + 1e-9
    lo, la = to_wgs(x, y)
    pres = preservation or random.choice(PRESERVATION)
    attrs = {
        'Inventory number': inv,
        'Description': desc or f'{OTYPES[otype][0]}, {MATERIALS[material][0].lower()}, {pres}',
        'Preservation': pres,
        'Weight (g)': str(weight if weight is not None else round(random.lognormvariate(2.6, .9), 1)),
        'Find spot': f'POINT Z ({lo:.7f} {la:.7f} {z:.2f})',
    }
    node('find', fid, inv, attrs)
    link(su_node[su], 'contains_find', fid)
    link(fid, 'otype', VOC + otype)
    link(fid, 'material', VOC + material)
    if dated and period:
        a, b = dating(period, otype)
        # The time-span is folded into the production, as the Studio does
        # with literal-only nodes: one node to collapse, not two.
        prod = node('prod', fid + '_prod', f'Production of {inv}',
                    {'begin_of_the_begin': year(a), 'end_of_the_end': year(b)})
        link(fid, 'produced_by', prod)
    find_spots.append((inv, x, y, z, su))
    return fid


# How many finds, and how much of it is older material dug up and dumped
# again (residual): little in a floor, most of it in a looters' backfill.
FINDS = {  # interpretation: ((min, max), share residual)
    'flood_deposit': ((4, 9), .3), 'looting_pit_fill': ((9, 13), .7),
    'collapse_wall': ((3, 7), .5), 'destruction_burning': ((6, 10), .1), 'floor': ((4, 9), .1),
    'use_horizont': ((4, 9), .15), 'pit_fill': ((5, 10), .2), 'wall_foundation': ((1, 3), .3),
    'construction_fill': ((3, 7), .3), 'well_fill': ((5, 10), .1),
}

for lab in sorted(bodies):
    b = bodies[lab]
    if b['kind'] == 'cut' or not b['period']:
        continue
    short, so_short, last_year = su_site[lab]
    period = PERIODS[b['period']]
    if period[0] == 'Modern':
        period = (period[0], period[1], last_year, period[3])
    older = sorted({bodies[o]['period'] for o in bodies if su_site[o][1] == so_short and bodies[o]['period']
                    and AGE[bodies[o]['period']] < AGE[b['period']]}, key=AGE.get)
    (lo_n, hi_n), residual = FINDS[b['interp']]
    for n in range(1, random.randint(lo_n, hi_n) + 1):
        p = period
        if n > 1 and older and random.random() < residual:  # the first one dates the unit
            p = PERIODS[random.choice(older)]
        ot = weighted(p[3])
        mats = TYPE_MATERIAL[ot]
        if AGE[p[0]] < AGE['Iron Age']:
            mats = {m: w for m, w in mats.items() if m not in NOT_YET}
        mat = weighted(mats)
        add_find(lab, n, ot, mat, p, dated=n == 1 or random.random() > .07)

# A few finds everybody will recognise.
add_find('SU1001', 90, 'whip', 'leather', ('Modern', 1930, 1938, {}), 'Whip, fragmented', 'fragmented', 210,
         z_rel=.8)
# The fire in both sondages: the latest coin in the debris is the same issue.
for su in ('SU1006', 'SU2006'):
    add_find(su, 94, 'coin', 'bronze', ('Late Roman', 388, 392, {}),
             'Coin, bronze, Late Roman, struck 388-392; burnt', 'almost complete', 2.4)
# Lying on the Late Roman floor, half a metre from the edge of the pit: the treasure hunters missed it.
add_find('SU1008', 91, 'tablet', 'lead', ('Late Roman', 300, 380, {}),
         'Lead tablet with an incised map', 'almost complete', 64, near=(3.6 - 1.4 - 0.5, 5.7), z_rel=.9)
# The coin that dates the treasure hunters at the Well.
add_find('SU3002', 95, 'coin', 'silver', ('Early Modern', 1678, 1683, {}),
         'Coin, silver, Ottoman akçe, struck c. 1680', 'complete', 0.7)
# At the base of the well fill, the Well.
WOS0 = np.array([16, 4])
add_find('SU3012', 92, 'idol', 'gold', ('Late Bronze Age', -1200, -1050, {}),
         'Golden idol, anthropomorphic', 'complete', 1840, near=WOS0 + (5.6, 6.3), z_rel=.04)
add_find('SU3012', 93, 'medallion', 'bronze', ('Late Bronze Age', -1200, -1050, {}),
         'Headpiece of a staff, with a sun disc', 'complete', 118, near=WOS0 + (6.4, 5.6), z_rel=.04)

# --- assemble ------------------------------------------------------------
node_types, edge_types = {}, {}
for n in nodes.values():
    node_types[n['t']] = node_types.get(n['t'], 0) + 1
    for k, v in n['o'].items():
        edge_types[k] = edge_types.get(k, 0) + len(v)

# referential integrity
for nid, n in nodes.items():
    for side in ('o', 'i'):
        for k, v in n[side].items():
            for t in v:
                assert t in nodes, (nid, k, t)

graph = {
    'meta': {
        'title': "Serpent's Meadow – fictional example excavation",
        'description': 'Invented example data in the style of the OntoCartographer Studio example. '
                       'All sites, people, units, finds and dates are fictional. Geometries: WGS84 (EPSG:4326); '
                       'elevations in metres above sea level.',
        'node_count': len(nodes),
        'edge_count': sum(edge_types.values()),
        'generated_by': 'GraphExplorer example generator',
    },
    'node_types': node_types,
    'edge_types': edge_types,
    'schema': {
        'typeColors': {T[k]: TYPE_INFO[k][0] for k in T},
        'typeLabels': {T[k]: TYPE_INFO[k][1] for k in T},
        'edgeLabels': edge_labels,
        'mainAttrs': {T['find']: ['Description'], T['su']: ['Description']},
        'typeLabelsI18n': {'de': {T[k]: TYPE_INFO[k][2] for k in T}},
    },
    'languages': {'primary': 'en', 'additional': ['de']},
    'nodes': nodes,
}

out_json = sys.argv[1]
stem = os.path.splitext(out_json)[0]
with open(out_json, 'w', encoding='utf-8', newline='\n') as f:
    json.dump(graph, f, ensure_ascii=False, indent=1)


# =========================================================================
# 3D for Blender: Wavefront OBJ
# =========================================================================
# Metres east/north of (E0, N0) in UTM 33N, height above sea level. Written
# Y-up, which is what Blender's OBJ import expects by default (forward -Z,
# up Y), so the scene arrives Z-up with north along +Y.
COLOURS = {
    'flood_deposit': (0.62, 0.52, 0.38), 'looting_pit_fill': (0.48, 0.42, 0.34),
    'collapse_wall': (0.70, 0.67, 0.60), 'destruction_burning': (0.16, 0.13, 0.12),
    'floor': (0.85, 0.80, 0.70), 'use_horizont': (0.56, 0.49, 0.41), 'pit_fill': (0.36, 0.30, 0.25),
    'wall_foundation': (0.80, 0.77, 0.70), 'construction_fill': (0.72, 0.58, 0.48),
    'natural_gravel': (0.66, 0.65, 0.60), 'well_fill': (0.88, 0.82, 0.62),
    'pit_cut': (0.85, 0.15, 0.15), 'looting_pit_cut': (0.85, 0.15, 0.15), 'well_cut': (0.85, 0.15, 0.15),
    'find': (0.95, 0.75, 0.15),
}
OCTA = [(1, 0, 0), (-1, 0, 0), (0, 1, 0), (0, -1, 0), (0, 0, 1), (0, 0, -1)]
OCTA_F = [(0, 2, 4), (2, 1, 4), (1, 3, 4), (3, 0, 4), (2, 0, 5), (1, 2, 5), (3, 1, 5), (0, 3, 5)]

mtl_name = os.path.basename(stem) + '.mtl'
with open(stem + '.mtl', 'w', encoding='utf-8', newline='\n') as f:
    for name, (r, g, b) in COLOURS.items():
        f.write(f'newmtl {name}\nKd {r:.3f} {g:.3f} {b:.3f}\nKa 0 0 0\nKs 0 0 0\nd 1\nillum 1\n\n')
with open(stem + '.obj', 'w', encoding='utf-8', newline='\n') as f:
    f.write("# Serpent's Meadow - fictional example excavation, generated by make_example.py\n"
            f'# x = metres east of E {E0}, -z = metres north of N {N0} (UTM 33N, EPSG:32633), y = metres a.s.l.\n'
            '# Object names are the node labels in GraphExplorer_Example.json.\n'
            f'mtllib {mtl_name}\n')
    base = 1
    for lab in sorted(bodies):
        m = bodies[lab]['mesh']
        f.write(f'o {lab}\nusemtl {bodies[lab]["interp"]}\n')
        f.writelines(f'v {x:.4f} {z:.4f} {-y:.4f}\n' for x, y, z in m.verts)
        f.writelines('f ' + ' '.join(str(base + i) for i in face) + '\n' for face in m.faces)
        base += len(m.verts)
    for inv, x, y, z, _ in find_spots:
        f.write(f'o {inv}\nusemtl find\n')
        r = 0.04
        f.writelines(f'v {x + r * a:.4f} {z + r * c:.4f} {-(y + r * b):.4f}\n' for a, b, c in OCTA)
        f.writelines('f ' + ' '.join(str(base + i) for i in face) + '\n' for face in OCTA_F)
        base += 6


# =========================================================================
# QGIS: GeoPackage in UTM 33N
# =========================================================================
try:
    from osgeo import ogr, osr
except ImportError:
    ogr = None
    print('GDAL Python bindings not found: no GeoPackage written (run with QGIS\'s Python to get one)')

if ogr is not None:
    gpkg = stem + '.gpkg'
    if os.path.exists(gpkg):
        os.remove(gpkg)
    ds = ogr.GetDriverByName('GPKG').CreateDataSource(gpkg)
    srs = osr.SpatialReference()
    srs.ImportFromEPSG(32633)

    def layer(name, gtype, fields):
        lyr = ds.CreateLayer(name, srs, gtype)
        for fname, ftype in fields:
            lyr.CreateField(ogr.FieldDefn(fname, ftype))
        return lyr

    def utm_poly(p):
        g = ogr.Geometry(ogr.wkbPolygon)
        for r in [p.exterior, *p.interiors]:
            ring = ogr.Geometry(ogr.wkbLinearRing)
            for x, y in r.coords:
                ring.AddPoint_2D(E0 + x, N0 + y)
            g.AddGeometry(ring)
        return g

    def put(lyr, geom, values):
        feat = ogr.Feature(lyr.GetLayerDefn())
        for k, v in values.items():
            feat.SetField(k, v)
        feat.SetGeometry(geom)
        lyr.CreateFeature(feat)

    S, R = ogr.OFTString, ogr.OFTReal
    lyr = layer('sondages', ogr.wkbPolygon, [('label', S), ('node_id', S), ('site', S)])
    for sid, (lab, short, outline) in sondage_plans.items():
        put(lyr, utm_poly(outline), {'label': lab, 'node_id': sid, 'site': short})

    # The bodies themselves are in the OBJ: as PolyhedralSurfaceZ they would
    # make this file thirty times larger, for a 3D view that Blender does better.
    plans = layer('su_plans', ogr.wkbMultiPolygon, [('label', S), ('node_id', S), ('sondage', S),
                                                     ('interpretation', S), ('period', S),
                                                     ('z_top', R), ('z_bottom', R)])
    for lab in sorted(bodies):
        b = bodies[lab]
        a = nodes[su_node[lab]]['a']
        mp = ogr.Geometry(ogr.wkbMultiPolygon)
        for p in getattr(b['plan'], 'geoms', [b['plan']]):
            mp.AddGeometry(utm_poly(p))
        put(plans, mp, {'label': lab, 'node_id': su_node[lab], 'sondage': su_site[lab][1],
                        'interpretation': INTERP[b['interp']][0], 'period': b['period'] or '',
                        'z_top': float(a['Elevation top (m)']), 'z_bottom': float(a['Elevation bottom (m)'])})

    finds_lyr = layer('finds', ogr.wkbPoint25D, [('label', S), ('node_id', S), ('su', S), ('description', S),
                                                ('z', R)])
    for inv, x, y, z, su in find_spots:
        fid = next(i for i in nodes[su_node[su]]['o'][E['contains_find'][0]] if nodes[i]['l'] == inv)
        pt3 = ogr.Geometry(ogr.wkbPoint25D)
        pt3.AddPoint(E0 + x, N0 + y, z)
        put(finds_lyr, pt3, {'label': inv, 'node_id': fid, 'su': su,
                             'description': nodes[fid]['a']['Description'], 'z': z})
    ds = None

print(f'{len(nodes)} nodes, {graph["meta"]["edge_count"]} edges, {find_count} finds, '
      f'{len(bodies)} units, {len(direct)} above/below relations')
