/* Die Browser-Seite der Kopplung -- die Mitte zwischen mehreren Anwendungen.
 *
 * Wird von src/main.jsx importiert und ist damit Teil jedes Builds: des
 * Explorers aus start.bat (npm run dev) und der Standalone-Datei. QGIS-Plugin und
 * Blender-Addon bringen keinen eigenen Explorer mit, sie verbinden sich mit
 * einem laufenden. Es gibt nur einen Explorer.
 *
 * **Warum die Seite die Mitte ist.** Ein WebSocket wird immer vom Browser aus
 * aufgebaut; die Anwendungen sind die Server. Sollen QGIS und Blender an
 * derselben Auswahl hängen, gäbe es zwei Wege: Eine Anwendung reicht alles für
 * die andere durch -- dann ist sie Zwischenstation, und ihr Ende reißt die
 * andere mit --, oder die Seite hält beide Leitungen. Sie hat ohnehin den
 * Graphen. Also hält sie beide, und keine Anwendung hängt von der anderen ab.
 *
 * Verbindungsdaten kommen aus window.__EXPLORER_LINK__ (schreibt der Wirt beim
 * Ausliefern hinein, siehe httpserver.py), ersatzweise aus dem URL-Fragment.
 * Weitere Anwendungen kommen zur Laufzeit über die Leiste unten links dazu.
 *
 * Ohne Verbindungsdaten ist das hier eine ganz normale Webseite: still, und
 * der Explorer funktioniert wie immer -- bis auf die kleine Leiste unten links,
 * über die sich QGIS oder Blender jederzeit nachträglich dazuschalten lassen.
 *
 * Vertrag mit der App: window.__GRAPH_EXPLORER_API__ = { version, store },
 * gesetzt von src/main.jsx.
 */
(function () {
  'use strict'

  if (window.__QGIS_BRIDGE_READY__) return
  window.__QGIS_BRIDGE_READY__ = true

  var HOP_LIMIT = 2       // wie weit von einem Knoten aus nach Schlüsselknoten gesucht wird
  var WAIT_TIMEOUT = 15000
  var WAIT_INTERVAL = 60

  var api = null          // { version, store }
  var links = []          // [{ socket, url, name, specs, lastSent, state }]
  var echoOrigin = null   // die Verbindung, deren Auswahl gerade eingespielt wird
  var chunks = []         // Teilstücke eines noch unvollständig übertragenen Graphen

  // -- Verbindungsdaten ------------------------------------------------------

  function initialLinks() {
    // __QGIS_LINK__ ist der alte Name aus der Zeit mit nur einem Wirt; er wird
    // weiter gelesen, damit ein älterer Wirt nicht stehenbleibt.
    var injected = window.__EXPLORER_LINK__ || window.__QGIS_LINK__
    if (injected && injected.ws && injected.token) {
      return [{ url: wsUrl(injected.ws, injected.token), name: injected.name || '' }]
    }

    var params = {}
    var raw = ((window.location && window.location.hash) || '').replace(/^#/, '')
    raw.split('&').forEach(function (pair) {
      if (!pair) return
      var eq = pair.indexOf('=')
      if (eq < 0) return
      params[decodeURIComponent(pair.slice(0, eq))] = decodeURIComponent(pair.slice(eq + 1))
    })
    if (params.ws && params.token) {
      return [{ url: wsUrl(params.ws, params.token), name: params.name || '' }]
    }
    return []
  }

  function wsUrl(port, token) {
    return 'ws://127.0.0.1:' + port + '/?token=' + encodeURIComponent(token)
  }

  /** Eine eingetippte Adresse auf ihre brauchbare Form bringen. */
  function parseAddress(text) {
    var s = String(text || '').trim()
    if (!s) return null
    if (s.indexOf('://') === -1) s = 'ws://' + s      // "127.0.0.1:5432?token=x" reicht
    try {
      var u = new URL(s)
      if (!u.searchParams.get('token')) return null    // ohne Marke weist der Wirt ohnehin ab
      return u.toString()
    } catch (e) {
      return null
    }
  }

  // -- Schlüssel eines einzelnen Knotens ------------------------------------

  function rawKey(graph, nodeId, spec) {
    var nd = graph.nodes[nodeId]
    if (!nd) return null
    if (spec.nodeType && nd.t !== spec.nodeType) return null
    if (spec.nodeSource === 'id') return nodeId
    if (spec.nodeSource === 'label') return nd.l == null ? null : String(nd.l)
    var v = (nd.a || {})[spec.nodeAttr]
    return v == null ? null : String(v)
  }

  /* Die Nachbarn *einer* Beziehung, in *einer* Richtung.
   *
   * Für die Werteübernahme muss die Beziehung benannt bleiben: "Anzahl der
   * Funde" ist etwas anderes als "Anzahl der Nachbarn", und wer eine Spalte
   * "Material" füllt, meint die Kante MATERIAL und nicht alles, was in der
   * Nähe hängt. Deshalb hier gezielt statt über neighbors(). */
  function related(graph, nodeId, dir, rel) {
    var nd = graph.nodes[nodeId]
    if (!nd) return []
    var group = ((dir === 'in' ? nd.i : nd.o) || {})[rel]
    return group || []
  }

  // Nachbarn in beide Richtungen -- identisch zu neighborNodeIds() in
  // src/lib/geo.js. Bewusst hier nachgebaut statt importiert: Diese Datei ist
  // ein loses Script ohne Modul-Kontext.
  function neighbors(graph, nodeId) {
    var out = []
    var nd = graph.nodes[nodeId]
    if (!nd) return out
    var group, k
    for (k in (nd.o || {})) {
      group = nd.o[k]
      for (var i = 0; i < group.length; i++) out.push(group[i])
    }
    for (k in (nd.i || {})) {
      group = nd.i[k]
      for (var j = 0; j < group.length; j++) out.push(group[j])
    }
    return out
  }

  /* Von einem beliebig ausgewählten Knoten zu den Schlüsseln, die ein Wirt kennt.
   *
   * Jeder Wirt hat seine eigenen Spezifikationen: QGIS koppelt vielleicht auf
   * ein Attribut, Blender auf das Label. Deshalb wird je Verbindung aufgelöst,
   * nicht einmal für alle.
   *
   * Der Knoten, den jemand anklickt, trägt den Schlüssel meistens nicht selbst.
   * Ein Fund ist kein Befund; seine SE hängt eine Kante weiter. Deshalb: erst
   * den Knoten selbst prüfen, dann ringförmig nach außen, und bei der ersten
   * Ebene aufhören, die etwas findet -- sonst zieht ein Knoten mit vielen
   * Nachbarn beim zweiten Hop den halben Graphen herein. */
  function keysForNode(nodeId, specs) {
    var graph = api.store.getState().graph
    if (!graph || !graph.nodes || !specs || !specs.length) return []

    var found = []
    var seen = {}
    seen[nodeId] = true
    var frontier = [nodeId]

    for (var hop = 0; hop <= HOP_LIMIT; hop++) {
      for (var i = 0; i < frontier.length; i++) {
        for (var s = 0; s < specs.length; s++) {
          var key = rawKey(graph, frontier[i], specs[s])
          if (key != null && key !== '' && found.indexOf(key) === -1) found.push(key)
        }
      }
      if (found.length) return found          // nächste Ebene würde nur verwässern
      if (hop === HOP_LIMIT) break

      var next = []
      for (var f = 0; f < frontier.length; f++) {
        var ns = neighbors(graph, frontier[f])
        for (var n = 0; n < ns.length; n++) {
          if (seen[ns[n]]) continue
          seen[ns[n]] = true
          next.push(ns[n])
        }
      }
      if (!next.length) break
      frontier = next
    }
    return found
  }

  /* Die Namen, unter denen der Explorer Typen, Beziehungen und Attribute zeigt.
   *
   * Ein Wirt bekommt sonst nur die Schlüssel -- bei Studio-Exporten Dinge wie
   * ".../A8_Stratigraphic_Unit#as:stratigraphic_unit", wo der Explorer
   * "Stratigraphic Unit" zeigt. Damit in QGIS dieselben Namen stehen wie hier,
   * kommen sie aus denselben Funktionen (lib/schema.js, über
   * __GRAPH_EXPLORER_API__.labels) und nicht aus einem Nachbau. Fehlen die
   * Funktionen (älterer Build), gibt es keine Namen, und der Wirt kürzt selbst. */
  function displayLabels(byType, rels) {
    var fns = api.labels
    if (!fns) return null
    var schema = api.store.getState().schema
    var out = { types: {}, rels: {}, attrs: {} }
    Object.keys(byType).forEach(function (t) {
      out.types[t] = fns.type(schema, t)
      for (var a in byType[t].attrs) out.attrs[a] = fns.attr(a)
    })
    Object.keys(rels).forEach(function (r) { out.rels[r] = fns.edge(schema, r) })
    return out
  }

  // -- Werte, die ein Wirt in seine eigene Tabelle übernehmen kann ----------
  //
  // Der Wirt (QGIS) hat eine Attributtabelle, der Graph hat Werte. Was hier
  // steht, ist die Graph-Seite davon: *welche* Werte es gäbe (describeValues)
  // und, für die ausgewählten, *welche* je Knoten (collectValues).
  //
  // Eine Wertquelle wird als Objekt beschrieben, nicht als Zeichenkette:
  //
  //     { kind: 'attr',  attr: 'ansprache' }
  //     { kind: 'label' }  { kind: 'id' }
  //     { kind: 'rel', dir: 'out', rel: 'ENTHAELT_FN', what: 'count' }
  //     { kind: 'rel', dir: 'in',  rel: 'GEHOERT_ZU',  what: 'attr', attr: 'phase' }
  //
  // Ein zusammengesetzter String ("rel:out:ENTHAELT_FN:count") wäre kürzer,
  // aber Beziehungs- und Attributnamen sind hier nicht in unserer Hand: Aus
  // importiertem RDF kommen Namen wie "crm:P46_is_composed_of" -- der Doppel-
  // punkt darin würde jedes Trennzeichen-Schema aushebeln. Ein Objekt hat das
  // Problem nicht.
  //
  // Mehrwertige Quellen liefern ein **Array**, keinen fertigen Text. Das
  // Zusammenfassen gehört dorthin, wo auch mehrere Knoten auf denselben
  // Schlüssel fallen können -- also zum Wirt (transfer.py), und dort an genau
  // eine Stelle.

  //: Über so viele Knoten wird das Inventar der Nachbarn abgetastet. Alle
  //: Kanten aller Knoten abzugehen, nur um Attributnamen einzusammeln, wäre
  //: bei 120.000 Knoten verschwenderisch -- welche Felder es *gibt*, zeigen
  //: die ersten paar hundert zuverlässig.
  var VALUE_SCAN = 400

  /** Alle Knoten, die für eine Verknüpfung überhaupt in Frage kommen. */
  function keyedNodes(graph, spec) {
    var out = []
    var ids = Object.keys(graph.nodes)
    for (var i = 0; i < ids.length; i++) {
      var key = rawKey(graph, ids[i], spec)
      if (key != null && key !== '') out.push({ id: ids[i], key: key })
    }
    return out
  }

  /** Der Wert einer Quelle an einem Knoten. null heißt: hat er nicht. */
  function valueOf(graph, nodeId, source) {
    var nd = graph.nodes[nodeId]
    if (!nd || !source) return null

    if (source.kind === 'id') return nodeId
    if (source.kind === 'label') return nd.l == null || nd.l === '' ? null : nd.l
    if (source.kind === 'attr') {
      var v = (nd.a || {})[source.attr]
      return v == null || v === '' ? null : v
    }
    if (source.kind !== 'rel') return null

    var ids = related(graph, nodeId, source.dir, source.rel)
    // Bewusst 0 und nicht null: "keine Funde" ist eine Aussage, kein fehlender
    // Wert. Eine leere Zelle würde später wie "nicht nachgesehen" aussehen.
    if (source.what === 'count') return ids.length

    var out = []
    for (var i = 0; i < ids.length; i++) {
      var n = graph.nodes[ids[i]]
      if (!n) continue
      var val = source.what === 'attr' ? (n.a || {})[source.attr] : n.l
      if (val == null || val === '') continue
      out.push(val)
    }
    return out.length ? out : null
  }

  // -- Was ein Wirt aufrufen kann -------------------------------------------
  //
  // Argumente kommen ausgepackt an, Rückgabewerte verpackt der Transport --
  // hier ist nirgends JSON.parse oder JSON.stringify nötig. `link` ist die
  // aufrufende Verbindung; nur setSpecs braucht sie, weil Spezifikationen je
  // Wirt gelten.

  var methods = {

    /* Knotentypen und die je Typ vorkommenden Attributschlüssel.
     * Füttert die Auswahllisten der Wirte, damit dort niemand einen
     * Property-Namen abtippen muss. */
    describeGraph: function () {
      var graph = api.store.getState().graph
      if (!graph || !graph.nodes) return { loaded: false, types: [] }

      var byType = {}
      var rels = {}
      var ids = Object.keys(graph.nodes)
      for (var i = 0; i < ids.length; i++) {
        var nd = graph.nodes[ids[i]]
        var bucket = byType[nd.t] || (byType[nd.t] = { type: nd.t, count: 0, attrs: {} })
        bucket.count++
        // Über alle Knoten eines Typs zu laufen wäre bei 120.000 Knoten
        // verschwenderisch, nur um Attribut- und Beziehungsnamen einzusammeln --
        // die ersten paar hundert je Typ zeigen das Inventar zuverlässig genug.
        if (bucket.count <= 200) {
          for (var a in (nd.a || {})) bucket.attrs[a] = true
          for (var ro in (nd.o || {})) rels[ro] = true
          for (var ri in (nd.i || {})) rels[ri] = true
        }
      }

      var types = Object.keys(byType).map(function (t) {
        return { type: t, count: byType[t].count, attrs: Object.keys(byType[t].attrs).sort() }
      })
      types.sort(function (x, y) { return y.count - x.count })

      var meta = graph.meta || {}
      var out = { loaded: true, title: meta.title || '', nodeCount: ids.length, types: types }
      var labels = displayLabels(byType, rels)
      if (labels) {
        out.labels = labels
        types.forEach(function (t) { t.label = labels.types[t.type] })
      }
      return out
    },

    /* Die Graph-Seite einer Verknüpfung: alle Knoten des konfigurierten Typs
     * mit ihrem Rohschlüssel. Der Wirt normalisiert und gleicht ab. */
    collectKeys: function (spec) {
      var graph = api.store.getState().graph
      if (!graph || !graph.nodes) return []
      return keyedNodes(graph, spec)
    },

    /* Welche Werte sich aus dem Graphen in eine Attributtabelle übernehmen ließen.
     *
     * Gefragt wird nach den Knoten *einer* Verknüpfung -- also nach genau
     * denen, die überhaupt an einem Feature hängen. Ein Inventar über den
     * ganzen Graphen wäre länger und zugleich unbrauchbarer: Was an einem
     * Fund-Knoten steht, hilft der SE-Tabelle nicht.
     *
     * Zu jedem Eintrag kommt mit, auf wie vielen dieser Knoten er vorkommt,
     * und ein Beispielwert. Beides ist der eigentliche Ertrag der Liste: Eine
     * Property, die 3 von 150 Knoten tragen, füllt auch nur 3 Zeilen -- das
     * soll man sehen, bevor die Spalte angelegt ist, und nicht danach. */
    describeValues: function (spec) {
      var graph = api.store.getState().graph
      if (!graph || !graph.nodes) return { total: 0, values: [] }

      var nodes = keyedNodes(graph, spec)
      var found = []      // Reihenfolge des ersten Auftretens
      var byKey = {}

      function note(id, source, label, group, value) {
        if (value == null || value === '') return
        var entry = byKey[id]
        if (!entry) {
          entry = byKey[id] = {
            source: source, label: label, group: group,
            count: 0, sample: '', kind: 'text', seen: false,
          }
          found.push(entry)
        }
        entry.count++
        if (entry.seen) return
        entry.seen = true

        var text = Array.isArray(value) ? value.join('; ') : String(value)
        entry.sample = text.length > 60 ? text.slice(0, 57) + '…' : text
        // Womit der Spaltentyp im Wirt vorbelegt wird.
        //
        // Eine Anzahl ist eine Zahl, und zwar immer -- auch wenn sie zufällig 0
        // ist. Alles andere gilt als Text, selbst wenn der erste Wert wie eine
        // Zahl aussieht: Ob *alle* Werte Zahlen sind, sagt eine Stichprobe
        // nicht, und eine SE-Nummer, die beim neunhundertsten Knoten "2001a"
        // heißt, wäre in einer Zahlenspalte eine leere Zelle. Text nimmt alles
        // an; umstellen ist im Wirt ein Klick, das Zurückholen verlorener Werte
        // nicht.
        entry.kind = source.what === 'count' ? 'int' : 'text'
      }

      for (var i = 0; i < nodes.length; i++) {
        var nd = graph.nodes[nodes[i].id]

        note('label', { kind: 'label' }, 'Beschriftung des Knotens', 'Knoten', nd.l)
        note('id', { kind: 'id' }, 'ID des Knotens', 'Knoten', nodes[i].id)
        for (var a in (nd.a || {})) {
          note('attr ' + a, { kind: 'attr', attr: a }, a, 'Knoten', nd.a[a])
        }

        // Die Nachbarschaft nur anfangs abtasten -- siehe VALUE_SCAN.
        if (i >= VALUE_SCAN) continue
        var dirs = [['out', nd.o], ['in', nd.i]]
        for (var d = 0; d < dirs.length; d++) {
          var dir = dirs[d][0]
          var groups = dirs[d][1] || {}
          for (var rel in groups) {
            var arrow = dir === 'out' ? '→ ' : '← '
            note('rel ' + dir + ' ' + rel + ' count',
                 { kind: 'rel', dir: dir, rel: rel, what: 'count' },
                 arrow + rel + ': Anzahl', 'Beziehungen',
                 groups[rel].length)
            note('rel ' + dir + ' ' + rel + ' label',
                 { kind: 'rel', dir: dir, rel: rel, what: 'label' },
                 arrow + rel + ': Beschriftungen', 'Beziehungen',
                 valueOf(graph, nodes[i].id, { kind: 'rel', dir: dir, rel: rel, what: 'label' }))

            // Erst sammeln, welche Attribute die Nachbarn überhaupt tragen,
            // dann je Attribut *einmal* eintragen -- mit dem Wert, den auch
            // collectValues liefern würde. Sonst zeigte das Beispiel den Wert
            // des ersten Nachbarn, während in der Zelle später alle stehen.
            var seenAttrs = {}
            for (var n = 0; n < groups[rel].length; n++) {
              var neighbor = graph.nodes[groups[rel][n]]
              if (!neighbor) continue
              for (var na in (neighbor.a || {})) seenAttrs[na] = true
            }
            for (var attr in seenAttrs) {
              var relAttr = { kind: 'rel', dir: dir, rel: rel, what: 'attr', attr: attr }
              note('rel ' + dir + ' ' + rel + ' attr ' + attr, relAttr,
                   arrow + rel + ': ' + attr, 'Beziehungen',
                   valueOf(graph, nodes[i].id, relAttr))
            }
          }
        }
      }

      // Häufiges nach oben: Was fast alle Knoten tragen, füllt die Spalte auch.
      found.sort(function (x, y) {
        if (x.group !== y.group) return x.group === 'Knoten' ? -1 : 1
        return y.count - x.count
      })
      // Die Zählung der Beziehungen bezieht sich auf den abgetasteten
      // Ausschnitt; das offen auszuweisen ist ehrlicher, als sie stillschweigend
      // wie eine Gesamtzahl aussehen zu lassen.
      var scanned = Math.min(nodes.length, VALUE_SCAN)
      for (var f = 0; f < found.length; f++) {
        found[f].of = found[f].group === 'Knoten' ? nodes.length : scanned
        delete found[f].seen
      }
      return { total: nodes.length, scanned: scanned, values: found }
    },

    /* Die Werte selbst -- nur die angeforderten, je Knoten einer.
     *
     * Rückgabe: [{ id, key, values: [...] }] in der Reihenfolge von `sources`.
     * Der Wirt gleicht `key` gegen sein Feld ab und schreibt `values` in seine
     * Tabelle; welche Zeile welche wird, entscheidet also weiter er. */
    collectValues: function (spec, sources) {
      var graph = api.store.getState().graph
      if (!graph || !graph.nodes) return []
      sources = sources || []

      var nodes = keyedNodes(graph, spec)
      for (var i = 0; i < nodes.length; i++) {
        var values = []
        for (var s = 0; s < sources.length; s++) {
          values.push(valueOf(graph, nodes[i].id, sources[s]))
        }
        nodes[i].values = values
      }
      return nodes
    },

    /* Ein Wirt hat etwas ausgewählt: den ersten passenden Knoten öffnen.
     *
     * Bewusst nur einer -- der Explorer zeigt genau einen Knoten im Detail, und
     * eine erfundene Mehrfachauswahl würde die Breadcrumb-Spur zerreißen. */
    selectNodes: function (nodeIds, link) {
      if (!nodeIds || !nodeIds.length) return 0
      // Der Kern der Kopplung zwischen zwei Anwendungen: Die Auswahl geht an
      // alle *anderen* Verbindungen weiter, nur nicht zurück an die, die sie
      // ausgelöst hat. Ein Klick in QGIS erreicht so Blender, ohne dass sich
      // die beiden gegenseitig aufschaukeln.
      echoOrigin = link || null
      try {
        api.store.getState().openInExplorer(nodeIds[0])
      } finally {
        setTimeout(function () { echoOrigin = null }, 0)
      }
      return nodeIds.length
    },

    /* Graph stückweise laden -- ein Grabungsbestand hat zweistellig viele
     * Megabyte, und Qt wie auch der eigene Server puffern eine eingehende
     * Nachricht vollständig, bevor sie ausgeliefert wird. */
    loadGraphChunk: function (text, isLast) {
      chunks.push(text)
      if (!isLast) return ''
      var joined = chunks.join('')
      chunks = []
      try {
        api.store.getState().loadGraph(JSON.parse(joined))
        return ''
      } catch (e) {
        return String(e && e.message ? e.message : e)
      }
    },

    /* Angefangene Übertragung verwerfen -- sonst hinge nach einem Abbruch ein
     * halber Graph im Speicher und würde beim nächsten Laden vorangestellt. */
    abortGraphLoad: function () {
      chunks = []
      return ''
    },

    setSpecs: function (next, link) {
      if (link) {
        link.specs = next || []
        link.lastSent = null
      }
      return (next || []).length
    },
  }

  // -- Auswahl im Explorer -> Wirte -----------------------------------------

  function pushSelection() {
    var id = api.store.getState().selectedId
    for (var i = 0; i < links.length; i++) {
      var link = links[i]
      if (!link.socket || link.socket.readyState !== 1) continue

      var keys = id ? keysForNode(id, link.specs) : []
      var fingerprint = keys.join('␟')

      if (link === echoOrigin) {
        // Von dort kam die Auswahl gerade -- nichts zurückschicken. Den Stand
        // aber trotzdem mitschreiben: Diese Verbindung *kennt* die Auswahl ja,
        // sie hat sie ausgelöst. Ohne diese Zeile bliebe ihr lastSent auf dem
        // vorigen Wert stehen, und die nächste Auswahl mit genau diesen
        // Schlüsseln -- etwa wenn die andere Anwendung dorthin zurückgeht --
        // würde als "schon gesendet" verworfen und käme nie an.
        link.lastSent = fingerprint
        continue
      }

      // Je Verbindung merken: Wer sich innerhalb einer SE von Fund zu Fund
      // bewegt, soll die Karte nicht bei jedem Schritt neu auswählen lassen.
      if (fingerprint === link.lastSent) continue
      link.lastSent = fingerprint
      send(link, { event: 'selection', nodeId: id || '', keys: keys })
    }
  }

  function send(link, payload) {
    if (link.socket && link.socket.readyState === 1) link.socket.send(JSON.stringify(payload))
  }

  // -- Verbindungen ----------------------------------------------------------

  function connect(url, name) {
    for (var i = 0; i < links.length; i++) {
      if (links[i].url === url) return links[i]     // schon verbunden
    }

    var link = { url: url, name: name || '', specs: [], lastSent: null, state: 'connecting', socket: null }
    links.push(link)

    var socket
    try {
      socket = new WebSocket(url)
    } catch (e) {
      link.state = 'error'
      renderPanel()
      return link
    }
    link.socket = socket

    socket.onopen = function () {
      link.state = 'open'
      send(link, { event: 'hello', token: tokenOf(url), apiVersion: api.version || 0 })
      // Leer statt null: Eine frisch verbundene Anwendung soll auf eine
      // *bestehende* Auswahl sofort nachziehen -- kommt Blender dazu, während
      // in QGIS schon eine SE ausgewählt ist, springt es gleich dorthin. Steht
      // gar nichts an, gibt es auch nichts zu melden; null hätte hier eine
      // leere Auswahl verschickt.
      link.lastSent = ''
      pushSelection()
      renderPanel()
    }

    socket.onmessage = function (ev) {
      var msg
      try {
        msg = JSON.parse(ev.data)
      } catch (e) {
        return
      }

      // Der Wirt stellt sich vor -- damit die Leiste "QGIS" und "Blender"
      // zeigen kann statt zweimal einer Portnummer.
      if (msg.event === 'host') {
        link.name = String(msg.name || '')
        renderPanel()
        return
      }

      var fn = methods[msg.method]
      if (!fn) return
      var result
      try {
        result = fn.apply(null, (msg.args || []).concat([link]))
      } catch (e) {
        send(link, { event: 'log', message: msg.method + ' fehlgeschlagen: ' + e })
        result = null
      }
      // Nur antworten, wenn eine Antwort erwartet wird -- eine id vergibt der
      // Wirt genau dann, wenn dort ein Rückruf wartet.
      if (msg.id != null) send(link, { id: msg.id, result: result === undefined ? null : result })
    }

    socket.onclose = function () {
      link.state = 'closed'
      renderPanel()
    }
    socket.onerror = function () {
      link.state = 'error'
      renderPanel()
    }

    renderPanel()
    return link
  }

  function tokenOf(url) {
    try {
      return new URL(url).searchParams.get('token') || ''
    } catch (e) {
      return ''
    }
  }

  function disconnect(link) {
    if (link.socket) {
      try {
        link.socket.close()
      } catch (e) { /* schon zu */ }
    }
    var idx = links.indexOf(link)
    if (idx >= 0) links.splice(idx, 1)
    renderPanel()
  }

  function label(link) {
    var port = ''
    try {
      port = new URL(link.url).port
    } catch (e) { /* egal */ }
    return link.name || ('Port ' + port)
  }

  // -- Die Leiste unten links ------------------------------------------------
  //
  // Ohne sie wäre nicht zu unterscheiden, ob gerade nichts hervorgehoben wird
  // oder ob eine Leitung weg ist -- die erste Frage, wenn ein Klick nichts
  // bewirkt. Und sie ist die Stelle, an der eine zweite Anwendung dazukommt.

  var panel = null
  var panelOpen = false

  function ensurePanel() {
    if (panel) return panel
    panel = document.createElement('div')
    panel.style.cssText =
      'position:fixed;left:8px;bottom:8px;z-index:99999;font:11px/1.5 system-ui,sans-serif;' +
      'background:#1f2933;color:#fff;border-radius:8px;padding:6px 8px;opacity:.92;' +
      'max-width:320px;box-shadow:0 2px 8px rgba(0,0,0,.3)'
    document.body.appendChild(panel)
    return panel
  }

  // Die Leiste ist Beiwerk, die Kopplung ist es nicht: Ein Fehler beim Zeichnen
  // darf nie eine Verbindung mitreißen. renderPanel() wird aus jedem
  // Socket-Rückruf aufgerufen -- ohne diese Klammer stünde die ganze Kopplung,
  // wenn irgendwo ein DOM-Aufruf fehlschlägt.
  function renderPanel() {
    try {
      renderPanelUnsafe()
    } catch (e) {
      if (window.console && console.warn) console.warn('Verbindungsleiste:', e)
    }
  }

  function renderPanelUnsafe() {
    // Immer sichtbar, auch ohne Verbindung: Der Explorer aus start.bat kennt
    // keine Verbindungsdaten, und genau dort soll sich QGIS oder Blender
    // nachträglich dazuschalten lassen. Solange nichts verbunden ist, bleibt
    // die Leiste zurückhaltend -- grauer Punkt statt rotem Alarm, denn "nicht
    // verbunden" ist dann kein Fehler, sondern der Normalfall.
    var el = ensurePanel()
    el.style.display = ''
    el.style.opacity = links.length || panelOpen ? '.92' : '.55'
    el.textContent = ''

    var open = links.filter(function (l) { return l.state === 'open' })

    var head = document.createElement('div')
    head.style.cssText = 'cursor:pointer;display:flex;gap:6px;align-items:center'
    head.title = 'Connect QGIS or Blender to this Explorer'
    var dot = document.createElement('span')
    dot.style.cssText = 'width:8px;height:8px;border-radius:50%;background:' +
      (open.length ? '#5cb85c' : links.length ? '#d9534f' : '#8a96a3')
    head.appendChild(dot)
    head.appendChild(document.createTextNode(
      open.length ? open.map(label).join(' · ')
        : links.length ? 'not connected'
        : 'Connect QGIS / Blender'
    ))
    var caret = document.createElement('span')
    caret.style.cssText = 'margin-left:auto;opacity:.6'
    caret.textContent = panelOpen ? '▾' : '▸'
    head.appendChild(caret)
    head.onclick = function () {
      panelOpen = !panelOpen
      renderPanel()
    }
    el.appendChild(head)

    if (!panelOpen) return

    links.forEach(function (link) {
      var row = document.createElement('div')
      row.style.cssText = 'display:flex;gap:6px;align-items:center;margin-top:4px;opacity:.85'
      row.appendChild(document.createTextNode(label(link) + ' — ' + stateText(link.state)))
      var x = document.createElement('button')
      x.textContent = '✕'
      x.title = 'Trennen'
      x.style.cssText = 'margin-left:auto;background:none;border:0;color:#fff;cursor:pointer;padding:0 2px'
      x.onclick = function () { disconnect(link) }
      row.appendChild(x)
      el.appendChild(row)
    })

    var hint = document.createElement('div')
    hint.style.cssText = 'margin-top:6px;opacity:.6'
    hint.textContent = (links.length ? 'Connect another application' : 'Connect an application') +
      ' — in QGIS or Blender, copy the connection for a running Explorer and paste it here:'
    el.appendChild(hint)

    var form = document.createElement('div')
    form.style.cssText = 'display:flex;gap:4px;margin-top:2px'
    var input = document.createElement('input')
    input.placeholder = 'ws://127.0.0.1:… ?token=…'
    input.style.cssText = 'flex:1;min-width:0;font:inherit;padding:2px 4px;border-radius:4px;' +
      'border:1px solid #556;background:#111820;color:#fff'
    var add = document.createElement('button')
    add.textContent = 'Connect'
    add.style.cssText = 'font:inherit;padding:2px 6px;border-radius:4px;border:0;cursor:pointer'
    function submit() {
      var url = parseAddress(input.value)
      if (!url) {
        input.style.borderColor = '#d9534f'
        return
      }
      input.value = ''
      input.style.borderColor = '#556'
      connect(url)
    }
    add.onclick = submit
    input.onkeydown = function (ev) { if (ev.key === 'Enter') submit() }
    form.appendChild(input)
    form.appendChild(add)
    el.appendChild(form)
  }

  function stateText(state) {
    return { open: 'connected', connecting: 'connecting …', closed: 'disconnected', error: 'not reachable' }[state] || state
  }

  // -- Verkabelung -----------------------------------------------------------

  function waitFor(test, onReady, onTimeout) {
    var waited = 0
    ;(function tick() {
      if (test()) return onReady()
      waited += WAIT_INTERVAL
      if (waited >= WAIT_TIMEOUT) return onTimeout()
      setTimeout(tick, WAIT_INTERVAL)
    })()
  }

  waitFor(
    function () { return window.__GRAPH_EXPLORER_API__ && window.__GRAPH_EXPLORER_API__.store },
    function () {
      api = window.__GRAPH_EXPLORER_API__

      // Auch ohne Wirt erreichbar: Von der Browser-Konsole aus lässt sich damit
      // nachsehen, was die Brücke aus dem Graphen macht, und eine Verbindung
      // von Hand aufbauen -- __QGIS_BRIDGE__.connect('ws://…?token=…').
      window.__QGIS_BRIDGE__ = methods
      methods.connect = connect
      methods.links = function () { return links }

      // Zustand v4 reicht dem subscribe-Callback (state, prevState) durch --
      // ein Vergleich genügt, subscribeWithSelector braucht es dafür nicht.
      api.store.subscribe(function (state, prev) {
        if (state.graph !== prev.graph) {
          // Ein neuer Graph heißt neue Knoten-IDs und neue Schlüssel. Ohne
          // diese Meldung arbeitet ein Wirt stillschweigend mit dem Index des
          // vorigen weiter -- oder, wenn er sich vor dem Laden verbunden hat,
          // mit einer leeren Graph-Seite. Dann funktioniert die Richtung
          // Explorer -> Wirt (die nur die Wirtsseite braucht) weiterhin, die
          // Gegenrichtung aber nie. Ein Fehlerbild, das nach Zufall aussieht
          // und keiner ist.
          for (var i = 0; i < links.length; i++) send(links[i], { event: 'graph' })
        }
        if (state.selectedId !== prev.selectedId || state.graph !== prev.graph) pushSelection()
      })

      initialLinks().forEach(function (entry) { connect(entry.url, entry.name) })
      renderPanel()
    },
    function () {
      // src/main.jsx setzt die API vor dem ersten Rendern -- fehlt sie, ist die
      // App beim Start gescheitert. Dann nur leise melden: Die App zeigt ihren
      // eigenen Fehler, ein Vollbild-Hinweis der Brücke würde ihn verdecken.
      if (window.console && console.warn) {
        console.warn('Verbindungsleiste: window.__GRAPH_EXPLORER_API__ fehlt -- ' +
          'QGIS/Blender können sich nicht verbinden.')
      }
    }
  )
})()
