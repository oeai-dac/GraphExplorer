"""Generates a fictional, Indy-style example graph for the GraphExplorer.

Everything here is invented: sites, people, units, finds, dates and
coordinates. The structure follows a real OntoCartographer Studio export
(CIDOC CRM + CRMarchaeo + CRMsci), so every tab of the Explorer has
something to show.

Usage: python make_example.py <out.json>
"""
import json
import math
import random
import sys

random.seed(1936)

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


# --- geography: the Prater in Vienna, by the Heustadlwasser, WGS84 -------
# (Austria has detailed background maps -- basemap.at -- to show the map off)
LON0, LAT0 = 16.415999, 48.202946
M_LAT = 1 / 111320
M_LON = 1 / (111320 * math.cos(math.radians(LAT0)))


def pt(x, y):  # metres east/north of the origin -> lon, lat
    return LON0 + x * M_LON, LAT0 + y * M_LAT


def rect(x, y, w, h):
    c = [pt(x, y), pt(x + w, y), pt(x + w, y + h), pt(x, y + h), pt(x, y)]
    return 'POLYGON ((' + ', '.join(f'{lo:.7f} {la:.7f}' for lo, la in c) + '))'


def poly_jitter(x, y, w, h):
    """An irregular unit outline inside the sondage."""
    cx, cy = x + w / 2, y + h / 2
    pts = []
    for k in range(9):
        a = 2 * math.pi * k / 9
        rx, ry = w / 2 * random.uniform(.55, .95), h / 2 * random.uniform(.55, .95)
        pts.append(pt(cx + rx * math.cos(a), cy + ry * math.sin(a)))
    pts.append(pts[0])
    return 'POLYGON ((' + ', '.join(f'{lo:.7f} {la:.7f}' for lo, la in pts) + '))'


# --- vocabularies --------------------------------------------------------
INTERP = {  # id: (en, de)
    'windblown_sand': ('Wind-blown sand', 'Flugsand'),
    'backfill_earlier_looting': ('Backfill following an earlier looting pit', 'Verfüllung einer älteren Raubgrube'),
    'collapse_mudbrick': ('Collapse of a mud-brick wall', 'Versturz einer Lehmziegelmauer'),
    'destruction_burning': ('Destruction layer with traces of burning', 'Zerstörungsschicht mit Brandspuren'),
    'floor': ('Floor', 'Fußboden'),
    'use_horizont': ('Use horizon in front of a structure', 'Nutzungshorizont vor einem Gebäude'),
    'pit_fill': ('Pit fill', 'Grubenverfüllung'),
    'wall_foundation': ('Wall foundation', 'Mauerfundament'),
    'construction_fill': ('Construction fill', 'Bauschüttung'),
    'bedrock': ('Natural bedrock', 'Anstehender Fels'),
}
OTYPES = {
    'sherd': ('Sherd', 'Scherbe'), 'oil_lamp': ('Oil lamp', 'Öllampe'), 'coin': ('Coin', 'Münze'),
    'amulet': ('Amulet', 'Amulett'), 'bead': ('Bead', 'Perle'), 'statuette': ('Statuette', 'Statuette'),
    'arrowhead': ('Arrowhead', 'Pfeilspitze'), 'nail': ('Nail', 'Nagel'), 'ostracon': ('Ostracon', 'Ostrakon'),
    'ring': ('Ring', 'Ring'), 'scarab': ('Scarab', 'Skarabäus'), 'vessel': ('Vessel', 'Gefäß'),
    'whip': ('Whip', 'Peitsche'), 'medallion': ('Medallion', 'Medaillon'), 'idol': ('Idol', 'Idol'),
}
MATERIALS = {
    'ceramic': ('Ceramic', 'Keramik'), 'terracotta': ('Terracotta', 'Terrakotta'), 'bronze': ('Bronze', 'Bronze'),
    'gold': ('Gold', 'Gold'), 'silver': ('Silver', 'Silber'), 'iron': ('Iron', 'Eisen'), 'glass': ('Glass', 'Glas'),
    'faience': ('Faience', 'Fayence'), 'bone': ('Bone', 'Knochen'), 'stone': ('Stone', 'Stein'), 'leather': ('Leather', 'Leder'),
}
# which materials an object type comes in (weighted)
TYPE_MATERIAL = {
    'sherd': {'ceramic': 1}, 'oil_lamp': {'ceramic': 4, 'bronze': 1}, 'coin': {'bronze': 5, 'silver': 2, 'gold': 1},
    'amulet': {'faience': 4, 'stone': 1, 'gold': 1}, 'bead': {'glass': 3, 'faience': 3, 'stone': 1},
    'statuette': {'terracotta': 4, 'bronze': 1, 'stone': 1}, 'arrowhead': {'bronze': 2, 'iron': 2, 'stone': 1},
    'nail': {'iron': 4, 'bronze': 1}, 'ostracon': {'ceramic': 1}, 'ring': {'bronze': 3, 'silver': 1, 'gold': 1},
    'scarab': {'faience': 3, 'stone': 2}, 'vessel': {'ceramic': 5, 'glass': 2, 'stone': 1},
}
# Periods, youngest first. Each: (name, from, to, object types with weights)
PERIODS = [
    ('Modern', 1900, 1989, {'sherd': 3, 'nail': 3, 'coin': 1}),
    ('Early Islamic', 640, 900, {'sherd': 6, 'oil_lamp': 2, 'coin': 2, 'glass_vessel': 0, 'vessel': 2, 'bead': 1}),
    ('Byzantine', 395, 640, {'sherd': 6, 'oil_lamp': 3, 'coin': 2, 'nail': 2, 'ring': 1, 'vessel': 1}),
    ('Roman', -30, 395, {'sherd': 6, 'coin': 3, 'oil_lamp': 2, 'nail': 2, 'bead': 1, 'ring': 1, 'statuette': 1}),
    ('Ptolemaic', -305, -30, {'sherd': 5, 'coin': 2, 'statuette': 2, 'amulet': 2, 'ostracon': 2, 'bead': 1}),
    ('Late Period', -664, -332, {'sherd': 4, 'amulet': 3, 'scarab': 2, 'bead': 2, 'statuette': 1, 'arrowhead': 1}),
    ('New Kingdom', -1292, -1077, {'sherd': 4, 'scarab': 3, 'amulet': 2, 'bead': 2, 'vessel': 2, 'arrowhead': 2}),
]
PRESERVATION = ['complete', 'almost complete', 'fragmented', 'fragmented', 'heavily fragmented']

for vid, (en, de) in INTERP.items():
    node('interp', VOC + vid, en, label_de=de)
for vid, (en, de) in OTYPES.items():
    node('otype', VOC + vid, en, label_de=de)
for vid, (en, de) in MATERIALS.items():
    node('material', VOC + vid, en, label_de=de)

# --- sites, people, excavations ------------------------------------------
ws = node('site', EX + 'wadi_al_sirr', 'Wadi al-Sirr', {'Description': 'Dry valley with several sites of different periods'})
node('ident', EX + 'WS', 'WS'); link(ws, 'ident', EX + 'WS')

people = {
    'jones': node('person', EX + 'person_h_jones', 'Dr. Henry Jones Jr.'),
    'sallah': node('person', EX + 'person_sallah', 'Sallah'),
    'ravenwood': node('person', EX + 'person_m_ravenwood', 'Marion Ravenwood'),
    'brody': node('person', EX + 'person_m_brody', 'Dr. Marcus Brody'),
}

SITES = [
    # site id, label, short, excavation id, excavation label, start, end, directors, origin (m), sondages
    ('the_secret_place', 'The Secret Place', 'TSP', 'secret_place_excavation', 'Excavation of the Secret Place',
     '1981', '1989', ['ravenwood', 'brody'], (0, 0),
     [('SO1', 'Secret Place Sondage 1', (0, 0, 10, 10), 1000, 15),
      ('SO2', 'Secret Place Sondage 2', (4, 24, 8, 6), 2000, 11)]),
    ('the_well_of_souls', 'The Well of Souls', 'WOS', 'well_of_souls_excavation', 'Excavation of the Well of Souls',
     '1936', '1938', ['jones', 'sallah'], (-185, 100),
     [('SO1', 'Well of Souls Sondage 1', (0, 0, 12, 12), 3000, 14)]),
]

all_sus = {}   # (site short, sondage) -> list of phases (list of su ids), top first
su_period = {}
su_geom = {}

for sid, slabel, short, xid, xlabel, start, end, directors, (ox, oy), sondages in SITES:
    site = node('site', EX + sid, slabel)
    node('ident', EX + short, short); link(site, 'ident', EX + short)
    link(ws, 'composed', site)
    exc = node('excav', EX + xid, xlabel, {'start_date': start, 'end_date': end})
    link(site, 'investigated_by', exc)
    for d in directors:
        link(exc, 'carried_out_by', people[d])

    for so, solabel, (x, y, w, h), base, n_su in sondages:
        so_id = node('sondage', EX + f'{short}-{so}', solabel,
                     {'Geometry': rect(ox + x, oy + y, w, h), 'Size': f'{w} × {h} m'})
        link(site, 'composed', so_id)
        nodes[exc]['o'].setdefault(E['investigated_by'][1], []).append(so_id)
        nodes[so_id]['i'].setdefault(E['investigated_by'][0], []).append(exc)

        # Phases top -> bottom; 1-3 units per phase.
        phases, made = [], 0
        while made < n_su:
            k = min(n_su - made, random.choice([1, 1, 2, 2, 3]))
            phases.append(list(range(made, made + k)))
            made += k
        ids = []
        for i in range(n_su):
            num = base + i + 1
            ids.append(EX + f'{short}-{so}-SU{num}')
        phase_ids = [[ids[i] for i in ph] for ph in phases]
        all_sus[(short, so)] = phase_ids

        # Interpretation and period run with depth.
        n_ph = len(phase_ids)
        interp_seq = ['windblown_sand', 'backfill_earlier_looting', 'collapse_mudbrick', 'destruction_burning',
                      'floor', 'use_horizont', 'pit_fill', 'wall_foundation', 'construction_fill']
        for pi, ph in enumerate(phase_ids):
            depth = pi / max(1, n_ph - 1)
            period = PERIODS[min(len(PERIODS) - 1, int(depth * (len(PERIODS) - .01)))]
            for j, uid in enumerate(ph):
                num = uid.rsplit('SU', 1)[1]
                if pi == n_ph - 1 and j == len(ph) - 1:
                    interp = 'bedrock'
                elif pi == 0 and j == 0:
                    interp = 'windblown_sand'
                else:
                    interp = interp_seq[min(len(interp_seq) - 1, 1 + int(depth * (len(interp_seq) - 1)) + random.choice([-1, 0, 0, 1]))]
                z_top = round(200.0 - pi * 0.35 - random.uniform(0, .1), 2)
                geom = poly_jitter(ox + x, oy + y, w, h)
                node('su', uid, f'SU{num}', {
                    'Description': f'{INTERP[interp][0]}; {random.choice(["loose", "compact", "firm"])} '
                                   f'{random.choice(["sandy", "silty", "clayey"])} matrix, '
                                   f'{random.choice(["light brown", "greyish brown", "reddish", "yellowish"])}',
                    'Elevation top (m)': f'{z_top:.2f}',
                    'Geometry': geom,
                })
                link(so_id, 'composed', uid)
                link(uid, 'interp', VOC + interp)
                su_period[uid] = None if interp == 'bedrock' else period
                su_geom[uid] = (ox + x, oy + y, w, h, z_top)
            # contemporary units within a phase
            if len(ph) >= 2:
                strat(ph[0], 'contemporary with', ph[1])

        # above/below between consecutive phases (direct neighbours only)
        for upper, lower in zip(phase_ids, phase_ids[1:]):
            for u in upper:
                targets = random.sample(lower, k=min(len(lower), random.choice([1, 1, 2])))
                for t in targets:
                    strat(u, 'above', t)
            for l in lower:  # nothing left floating
                if not any(l in nodes[u]['o'].get(AP11 + '#dot1:above', []) for u in upper):
                    strat(random.choice(upper), 'above', l)

# The same destruction layer, recorded in both sondages of the Secret Place.
strat(all_sus[('TSP', 'SO1')][2][0], 'equals', all_sus[('TSP', 'SO2')][2][0])

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


find_count = 0


def add_find(su, num, otype, material, period, desc=None, preservation=None, weight=None, dated=True):
    global find_count
    find_count += 1
    short_so = su.rsplit('/', 1)[1].rsplit('-SU', 1)[0]           # e.g. TSP-SO1
    su_num = su.rsplit('SU', 1)[1]
    inv = f'{short_so.split("-")[0]}-{su_num}-{num:02d}'
    fid = EX + f'{short_so}-SU{su_num}-{num:02d}'
    x, y, w, h, z = su_geom[su]
    lo, la = pt(x + random.uniform(.8, w - .8), y + random.uniform(.8, h - .8))
    pres = preservation or random.choice(PRESERVATION)
    attrs = {
        'Inventory number': inv,
        'Description': desc or f'{OTYPES[otype][0]}, {MATERIALS[material][0].lower()}, {pres}',
        'Preservation': pres,
        'Weight (g)': str(weight if weight is not None else round(random.lognormvariate(2.6, .9), 1)),
        'Find spot': f'POINT Z ({lo:.7f} {la:.7f} {z - random.uniform(.02, .3):.2f})',
    }
    node('find', fid, inv, attrs)
    link(su, 'contains_find', fid)
    link(fid, 'otype', VOC + otype)
    link(fid, 'material', VOC + material)
    if dated and period:
        a, b = dating(period, otype)
        # The time-span is folded into the production, as the Studio does
        # with literal-only nodes: one node to collapse, not two.
        prod = node('prod', fid + '_prod', f'Production of {inv}',
                    {'begin_of_the_begin': year(a), 'end_of_the_end': year(b)})
        link(fid, 'produced_by', prod)
    return fid


for (short, so), phases in all_sus.items():
    for ph in phases:
        for su in ph:
            period = su_period[su]
            if period is None:
                continue
            for n in range(1, random.randint(4, 11)):
                ot = weighted(period[3])
                mat = weighted(TYPE_MATERIAL[ot])
                add_find(su, n, ot, mat, period, dated=random.random() > .07)

# A few finds everybody will recognise.
tsp_top = all_sus[('TSP', 'SO1')][0][0]
wos_bottom = [u for u in all_sus[('WOS', 'SO1')][-2]][0]
add_find(tsp_top, 90, 'whip', 'leather', ('Modern', 1930, 1936, {}), 'Whip, fragmented', 'fragmented', 210)
add_find(all_sus[('TSP', 'SO1')][1][0], 91, 'ostracon', 'ceramic', ('Ptolemaic', -250, -200, {}),
         'Ostracon with an ancient map', 'almost complete', 64)
add_find(wos_bottom, 92, 'idol', 'gold', ('New Kingdom', -1279, -1213, {}),
         'Golden idol, anthropomorphic', 'complete', 1840)
add_find(wos_bottom, 93, 'medallion', 'bronze', ('New Kingdom', -1279, -1213, {}),
         'Headpiece of a staff, with a sun disc and inscription', 'complete', 118)

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

type_key = {v: k for k, v in T.items()}
graph = {
    'meta': {
        'title': 'Wadi al-Sirr – fictional example excavation',
        'description': 'Invented example data in the style of the OntoCartographer Studio example. '
                       'All sites, people, units, finds and dates are fictional. Geometries: WGS84 (EPSG:4326).',
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

with open(sys.argv[1], 'w', encoding='utf-8', newline='\n') as f:
    json.dump(graph, f, ensure_ascii=False, indent=1)
print(f'{len(nodes)} nodes, {graph["meta"]["edge_count"]} edges, {find_count} finds, '
      f'{sum(len(p) for ph in all_sus.values() for p in ph)} units')
