export class CircuitCore {
    constructor() {
        this.components = [];
        this.wires = [];
        this.junctions = [];          // NEW: { id, x, y }
        this.selectedId = null;
        this.selectedWireId = null;
        this.selectedTerminal = null; // { compId|junctionId, nodeIndex (or null for junction), node: {x,y,id,parent?} }
        this.simulationRunning = false;
        this.dragState = { active: false, item: null, offset: { x: 0, y: 0 } };
        this.nextId = 1;
        this.gridSize = 40;
        this.currentAnimationId = null;
        this.shortCircuit = false;
    }

    getComponentName(type) {
        if (type === 'B') return 'Bulb';
        if (type === 'V') return 'Voltage Source';
        return type;
    }

    createNodesForType(type, x, y, id) {
        if (type === 'V') {
            return [
                { id: `${id}-n0`, x, y: y - 20, parent: id, index: 0 },
                { id: `${id}-n1`, x, y: y + 20, parent: id, index: 1 }
            ];
        } else if (type === 'B') {
            return [
                { id: `${id}-n0`, x: x - 20, y, parent: id, index: 0 },
                { id: `${id}-n1`, x: x + 20, y, parent: id, index: 1 }
            ];
        }
        return [];
    }

    createComponent(type, x, y) {
        if (!['B', 'V'].includes(type)) return null;

        const id = `comp-${this.nextId++}`;
        const component = {
            id,
            type,
            x,
            y,
            value: type === 'B' ? 100 : 9,
            nodes: this.createNodesForType(type, x, y, id),
            voltage: 0,
            current: 0
        };

        this.components.push(component);
        return component;
    }

    // -------------------------------------------------------------------------
    // Junction management
    // -------------------------------------------------------------------------

    createJunction(x, y) {
        const id = `junc-${this.nextId++}`;
        const junction = { id, x, y };
        this.junctions.push(junction);
        return junction;
    }

    deleteJunction(junctionId) {
        this.wires = this.wires.filter(w =>
            w.fromComp !== junctionId && w.toComp !== junctionId
        );
        this.junctions = this.junctions.filter(j => j.id !== junctionId);
    }

    /**
     * Split a wire at (x, y) by inserting a junction and replacing the original
     * wire with two wires that share the new junction as an endpoint.
     * Returns the new junction or null if wire not found.
     */
    splitWireAt(wireId, x, y) {
        const wire = this.wires.find(w => w.id === wireId);
        if (!wire) return null;

        const junc = this.createJunction(x, y);

        // Wire A: original start → junction
        const wireA = {
            id: `wire-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            x1: wire.x1, y1: wire.y1,
            x2: junc.x,  y2: junc.y,
            fromComp: wire.fromComp, fromNodeIdx: wire.fromNodeIdx,
            toComp: junc.id,         toNodeIdx: 0,
            current: 0
        };

        // Wire B: junction → original end
        const wireB = {
            id: `wire-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            x1: junc.x,  y1: junc.y,
            x2: wire.x2, y2: wire.y2,
            fromComp: junc.id,      fromNodeIdx: 0,
            toComp: wire.toComp,    toNodeIdx: wire.toNodeIdx,
            current: 0
        };

        this.wires = this.wires.filter(w => w.id !== wireId);
        this.wires.push(wireA, wireB);

        return junc;
    }

    // -------------------------------------------------------------------------
    // Wire helpers
    // -------------------------------------------------------------------------

    findWireBetween(compA, nodeA, compB, nodeB) {
        return this.wires.find(w =>
            (w.fromComp === compA && w.fromNodeIdx === nodeA && w.toComp === compB && w.toNodeIdx === nodeB) ||
            (w.fromComp === compB && w.fromNodeIdx === nodeB && w.toComp === compA && w.toNodeIdx === nodeA)
        ) || null;
    }

    /**
     * Returns all wires connected to a given terminal.
     * For component terminals the old single-wire limit is lifted; junctions
     * naturally support unlimited connections.
     */
    findWiresAtTerminal(compId, nodeIdx) {
        return this.wires.filter(w =>
            (w.fromComp === compId && w.fromNodeIdx === nodeIdx) ||
            (w.toComp   === compId && w.toNodeIdx   === nodeIdx)
        );
    }

    /** Legacy compat — returns first wire at terminal or null */
    findWireAtTerminal(compId, nodeIdx) {
        return this.findWiresAtTerminal(compId, nodeIdx)[0] || null;
    }

    /**
     * Component terminals: still limited to one wire each (component pin is a
     * single physical contact).  Junction terminals: unlimited.
     * Returns true if adding another wire here would violate the constraint.
     */
    _terminalFull(compId, nodeIdx) {
        const isJunction = compId.startsWith('junc-');
        if (isJunction) return false; // junctions accept any number of wires
        return this.findWiresAtTerminal(compId, nodeIdx).length > 0;
    }

    createWire(startNode, endNode, endCompId, endNodeIdx) {
        const startCompId  = startNode.parent || startNode.compId || startNode.id;
        const startNodeIdx = startNode.index  !== undefined ? startNode.index : 0;

        // Validate both endpoints exist
        const startExists = this.components.find(c => c.id === startCompId) ||
                            this.junctions.find(j => j.id === startCompId);
        const endExists   = this.components.find(c => c.id === endCompId) ||
                            this.junctions.find(j => j.id === endCompId);

        if (!startExists || !endExists) return { wire: null, error: 'Component/junction not found' };

        // Prevent self-loop
        if (startCompId === endCompId && startNodeIdx === endNodeIdx) {
            return { wire: null, error: 'Cannot connect terminal to itself' };
        }

        // Prevent duplicate wire
        if (this.findWireBetween(startCompId, startNodeIdx, endCompId, endNodeIdx)) {
            return { wire: null, error: 'Wire already exists between these terminals' };
        }

        // Enforce single-wire-per-pin rule for component (non-junction) terminals
        if (this._terminalFull(startCompId, startNodeIdx)) {
            return { wire: null, error: 'Start terminal already connected — place a junction to branch' };
        }
        if (this._terminalFull(endCompId, endNodeIdx)) {
            return { wire: null, error: 'End terminal already connected — place a junction to branch' };
        }

        const wire = {
            id: `wire-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
            x1: startNode.x, y1: startNode.y,
            x2: endNode.x,   y2: endNode.y,
            fromComp: startCompId, fromNodeIdx: startNodeIdx,
            toComp:   endCompId,   toNodeIdx:   endNodeIdx,
            current: 0
        };

        this.wires.push(wire);
        return { wire, error: null };
    }

    deleteWire(wireId) {
        this.wires = this.wires.filter(w => w.id !== wireId);
        if (this.selectedWireId === wireId) this.selectedWireId = null;

        // Prune orphaned junctions (connected to 0 or 1 wire — useless)
        this._pruneOrphanedJunctions();
    }

    _pruneOrphanedJunctions() {
        this.junctions = this.junctions.filter(j => {
            const count = this.wires.filter(w =>
                w.fromComp === j.id || w.toComp === j.id
            ).length;
            return count >= 2; // keep only meaningful branch points
        });
    }

    deleteComponent(id) {
        this.wires = this.wires.filter(w => w.fromComp !== id && w.toComp !== id);
        this.components = this.components.filter(c => c.id !== id);

        if (this.selectedTerminal?.compId === id) this.selectedTerminal = null;
        if (this.selectedId === id) this.selectedId = null;
        if (this.selectedWireId) {
            const still = this.wires.find(w => w.id === this.selectedWireId);
            if (!still) this.selectedWireId = null;
        }

        this._pruneOrphanedJunctions();
    }

    // -------------------------------------------------------------------------
    // Graph helpers
    // -------------------------------------------------------------------------

    /**
     * Build nets via union-find.
     * Terminals are identified as `${compId}-${nodeIdx}` for components and
     * `${junctionId}-0` for junctions (junctions have a single implicit terminal).
     */
    _buildNets() {
        const parent = {};

        // Register component terminals
        this.components.forEach(comp => {
            comp.nodes.forEach((_, idx) => {
                const key = `${comp.id}-${idx}`;
                parent[key] = key;
            });
        });

        // Register junction terminals
        this.junctions.forEach(j => {
            const key = `${j.id}-0`;
            parent[key] = key;
        });

        const find = (x) => {
            if (parent[x] !== x) parent[x] = find(parent[x]);
            return parent[x];
        };
        const union = (a, b) => {
            if (parent[a] === undefined) parent[a] = a;
            if (parent[b] === undefined) parent[b] = b;
            parent[find(a)] = find(b);
        };

        this.wires.forEach(w => {
            const fromKey = `${w.fromComp}-${w.fromNodeIdx}`;
            const toKey   = `${w.toComp}-${w.toNodeIdx}`;
            union(fromKey, toKey);
        });

        const terminalNet = {};
        Object.keys(parent).forEach(k => { terminalNet[k] = find(k); });

        const nets = [...new Set(Object.values(terminalNet))];

        return { terminalNet, nets };
    }

    isCircuitComplete() {
        const battery = this.components.find(c => c.type === 'V');
        if (!battery) return false;

        const { terminalNet } = this._buildNets();

        const posNet = terminalNet[`${battery.id}-0`];
        const negNet = terminalNet[`${battery.id}-1`];

        if (posNet === negNet) return true; // short circuit still counts

        const netAdj = new Map();
        const addEdge = (a, b) => {
            if (!netAdj.has(a)) netAdj.set(a, new Set());
            if (!netAdj.has(b)) netAdj.set(b, new Set());
            netAdj.get(a).add(b);
            netAdj.get(b).add(a);
        };

        this.components.forEach(comp => {
            if (comp.nodes.length === 2) {
                const n0 = terminalNet[`${comp.id}-0`];
                const n1 = terminalNet[`${comp.id}-1`];
                if (n0 && n1 && n0 !== n1) addEdge(n0, n1);
            }
        });

        const visited = new Set([posNet]);
        const queue = [posNet];
        while (queue.length) {
            const curr = queue.shift();
            if (curr === negNet) return true;
            for (const nb of (netAdj.get(curr) || [])) {
                if (!visited.has(nb)) { visited.add(nb); queue.push(nb); }
            }
        }
        return false;
    }

    // -------------------------------------------------------------------------
    // Solver — Modified Nodal Analysis (MNA)
    // -------------------------------------------------------------------------

    solveCircuit() {
        this.shortCircuit = false;

        if (this.components.length === 0) {
            return { success: false, message: 'No components in circuit' };
        }

        this.components.forEach(c => { c.current = 0; c.voltage = 0; });
        this.wires.forEach(w => { w.current = 0; });

        const battery = this.components.find(c => c.type === 'V');
        const bulbs   = this.components.filter(c => c.type === 'B');

        if (!battery) return { success: false, message: 'No voltage source in circuit' };
        if (bulbs.length === 0) return { success: false, message: 'No bulbs in circuit' };
        if (!this.isCircuitComplete()) return { success: false, message: 'Circuit is open — no complete loop' };

        const { terminalNet, nets } = this._buildNets();

        const groundNet = terminalNet[`${battery.id}-1`];

        if (terminalNet[`${battery.id}-0`] === groundNet) {
            this.shortCircuit = true;
            battery.voltage = battery.value;
            battery.current = Infinity;
            return { success: false, message: '⚡ Short circuit detected!', shortCircuit: true };
        }

        const nonGroundNets = nets.filter(n => n !== groundNet);
        const netIndex = {};
        nonGroundNets.forEach((n, i) => { netIndex[n] = i; });
        const numNodes = nonGroundNets.length;

        const voltageSources = this.components.filter(c => c.type === 'V');
        const numVSources = voltageSources.length;

        const size = numNodes + numVSources;

        const A = Array.from({ length: size }, () => new Array(size).fill(0));
        const b = new Array(size).fill(0);

        const nIdx = (net) => (net === groundNet || net === undefined) ? -1 : (netIndex[net] ?? -1);

        // Stamp resistors (bulbs)
        bulbs.forEach(comp => {
            const R = comp.value > 0 ? comp.value : 1e-9;
            const G = 1 / R;
            const ni = nIdx(terminalNet[`${comp.id}-0`]);
            const nj = nIdx(terminalNet[`${comp.id}-1`]);

            if (ni >= 0) A[ni][ni] += G;
            if (nj >= 0) A[nj][nj] += G;
            if (ni >= 0 && nj >= 0) { A[ni][nj] -= G; A[nj][ni] -= G; }
        });

        // Stamp voltage sources
        voltageSources.forEach((vs, k) => {
            const vsRow = numNodes + k;
            const posNi = nIdx(terminalNet[`${vs.id}-0`]);
            const negNi = nIdx(terminalNet[`${vs.id}-1`]);

            if (posNi >= 0) { A[vsRow][posNi] =  1; A[posNi][vsRow] =  1; }
            if (negNi >= 0) { A[vsRow][negNi] = -1; A[negNi][vsRow] = -1; }
            b[vsRow] = vs.value;
        });

        const x = this._gaussSolve(A, b);
        if (!x) return { success: false, message: 'Solver failed (singular matrix)' };

        const nodeVoltage = (net) =>
            (!net || net === groundNet) ? 0 : (x[netIndex[net]] || 0);

        // Back-annotate voltage sources
        voltageSources.forEach((vs, k) => {
            vs.current = x[numNodes + k];
            vs.voltage = vs.value;
        });

        // Back-annotate bulbs
        bulbs.forEach(comp => {
            const R = comp.value > 0 ? comp.value : 1e-9;
            const vPos = nodeVoltage(terminalNet[`${comp.id}-0`]);
            const vNeg = nodeVoltage(terminalNet[`${comp.id}-1`]);
            const vDrop = vPos - vNeg;
            comp.voltage = vDrop;
            comp.current = vDrop / R;
        });

        // ----------------------------------------------------------------
        // Wire current annotation — proper KCL approach
        //
        // Each wire connects two nets.  Current through the wire = sum of
        // all component-branch currents that flow *into* the fromNet from
        // the toNet side.  For a simple series circuit this equals the
        // battery current.  For parallel branches it equals the branch current
        // flowing through whichever resistor sits on that wire segment.
        //
        // Implementation: for each wire, find all components whose BOTH
        // terminals are on {fromNet, toNet} — those form the parallel group
        // sharing this wire.  The wire carries the aggregate current between
        // those two nets, attributed to the nearest branch.
        //
        // Simpler & equally correct: trace which component is directly
        // "on" this wire segment by checking if the wire's fromComp or
        // toComp is a real component.
        // ----------------------------------------------------------------
        this.wires.forEach(wire => {
            const fromNetId = terminalNet[`${wire.fromComp}-${wire.fromNodeIdx}`];
            const toNetId   = terminalNet[`${wire.toComp}-${wire.toNodeIdx}`];

            if (!fromNetId || !toNetId || fromNetId === toNetId) {
                wire.current = voltageSources[0]?.current || 0;
                return;
            }

            const Vfrom = nodeVoltage(fromNetId);
            const Vto   = nodeVoltage(toNetId);

            // Aggregate all resistor currents between these two nets
            let netCurrent = 0;
            let found = false;

            bulbs.forEach(comp => {
                const c0 = terminalNet[`${comp.id}-0`];
                const c1 = terminalNet[`${comp.id}-1`];
                if ((c0 === fromNetId && c1 === toNetId) ||
                    (c1 === fromNetId && c0 === toNetId)) {
                    netCurrent += comp.current;
                    found = true;
                }
            });

            if (!found) {
                // Wire is in a net that contains no resistor branch directly
                // (e.g. a wire on the battery side) — use battery current
                voltageSources.forEach(vs => {
                    const v0 = terminalNet[`${vs.id}-0`];
                    const v1 = terminalNet[`${vs.id}-1`];
                    if ((v0 === fromNetId || v0 === toNetId) ||
                        (v1 === fromNetId || v1 === toNetId)) {
                        netCurrent = vs.current;
                        found = true;
                    }
                });
            }

            // Direction: positive means current flows from→to (conventional)
            // If Vfrom > Vto, current flows in direction of wire
            wire.current = (Vfrom >= Vto) ? Math.abs(netCurrent) : -Math.abs(netCurrent);
        });

        const V    = battery.value;
        const Ibat = Math.abs(battery.current);
        return {
            success: true,
            message: `V=${V}V  I_bat=${(Ibat * 1000).toFixed(1)}mA`,
            V, I: Ibat
        };
    }

    // -------------------------------------------------------------------------
    // Gaussian elimination with partial pivoting
    // -------------------------------------------------------------------------
    _gaussSolve(A, b) {
        const n = b.length;
        const M = A.map((row, i) => [...row, b[i]]);

        for (let col = 0; col < n; col++) {
            let maxRow = col;
            let maxVal = Math.abs(M[col][col]);
            for (let row = col + 1; row < n; row++) {
                if (Math.abs(M[row][col]) > maxVal) {
                    maxVal = Math.abs(M[row][col]);
                    maxRow = row;
                }
            }
            if (maxVal < 1e-12) return null;

            [M[col], M[maxRow]] = [M[maxRow], M[col]];

            for (let row = 0; row < n; row++) {
                if (row === col) continue;
                const factor = M[row][col] / M[col][col];
                for (let k = col; k <= n; k++) {
                    M[row][k] -= factor * M[col][k];
                }
            }
        }

        return M.map((row, i) => row[n] / row[i]);
    }

    log(message, type = 'info') {
        console.log(`[${type}] ${message}`);
    }
}