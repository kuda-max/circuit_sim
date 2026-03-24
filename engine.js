
import { CircuitCore } from './core.js';

class CircuitEngine extends CircuitCore {
    constructor() {
        super();

        this.svg = document.getElementById('circuit-svg');
        this.componentsLayer = document.getElementById('components-layer');
        this.wiresLayer = document.getElementById('wires-layer');
        this.currentsLayer = document.getElementById('currents-layer');
        this.tempWireLayer = document.getElementById('temp-wire-layer');
        this.inspector = document.getElementById('inspector-content');
        this.logContent = document.getElementById('log-content');

        this._shortCircuitFlash = false;
        this._shortCircuitFlashTimer = null;

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupDragAndDrop();
        this.updateStats();
        this.log('Circuit Engine ready — click terminals to connect; click a wire to place a junction');
    }

    setupEventListeners() {
        this.svg.addEventListener('mousedown', (e) => this.handleMouseDown(e));
        this.svg.addEventListener('mousemove', (e) => this.handleMouseMove(e));
        this.svg.addEventListener('mouseup', () => this.handleMouseUp());

        window.addEventListener('resize', () => this.render());

        document.getElementById('btn-run').addEventListener('click', () => this.startSimulation());
        document.getElementById('btn-stop').addEventListener('click', () => this.stopSimulation());
        document.getElementById('btn-step').addEventListener('click', () => this.stepSimulation());

        this.svg.addEventListener('mousemove', (e) => {
            const pt = this.getSVGPoint(e);
            const x = Math.round(pt.x / this.gridSize) * this.gridSize;
            const y = Math.round(pt.y / this.gridSize) * this.gridSize;
            document.getElementById('grid-pos').textContent = `Grid: ${x}, ${y}`;
        });

        document.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' && this.selectedTerminal) {
                this.selectedTerminal = null;
                this.render();
                this.log('Terminal selection cancelled');
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedWireId) {
                this.deleteWire(this.selectedWireId);
                this.updateStats();
                this.render();
                this.updateInspector();
            }
            if ((e.key === 'Delete' || e.key === 'Backspace') && this.selectedId) {
                this.deleteComponent(this.selectedId);
            }
        });

        this.svg.addEventListener('click', (e) => {
            if (e.target === this.svg) {
                this.selectedTerminal = null;
                this.selectedId = null;
                this.selectedWireId = null;
                this.render();
                this.updateInspector();
            }
        });
    }

    setupDragAndDrop() {
        document.querySelectorAll('.component-item').forEach(item => {
            item.addEventListener('dragstart', (e) => {
                const type = item.dataset.type;
                if (['B', 'V'].includes(type)) {
                    e.dataTransfer.setData('component-type', type);
                    e.dataTransfer.effectAllowed = 'copy';
                } else {
                    e.preventDefault();
                    this.log(`${type} component not available`, 'warning');
                }
            });
        });

        this.svg.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'copy';
        });

        this.svg.addEventListener('drop', (e) => {
            e.preventDefault();
            const type = e.dataTransfer.getData('component-type');
            if (type && ['B', 'V'].includes(type)) {
                const pt = this.getSVGPoint(e);
                const x = Math.round(pt.x / this.gridSize) * this.gridSize;
                const y = Math.round(pt.y / this.gridSize) * this.gridSize;
                this.createComponent(type, x, y);
            }
        });
    }

    getSVGPoint(evt) {
        const pt = this.svg.createSVGPoint();
        pt.x = evt.clientX;
        pt.y = evt.clientY;
        return pt.matrixTransform(this.svg.getScreenCTM().inverse());
    }

    createComponent(type, x, y) {
        const comp = super.createComponent(type, x, y);
        if (!comp) return;

        this.selectComponent(comp.id);
        this.log(`Created ${this.getComponentName(type)} at (${x}, ${y})`);
        this.updateStats();

        if (this.simulationRunning) {
            const result = super.solveCircuit();
            this.handleSolverResult(result);
        }

        this.render();
    }

    // -------------------------------------------------------------------------
    // Terminal / junction click handling
    // -------------------------------------------------------------------------

    /**
     * Called when user clicks a component terminal.
     * First click → selects it as wire start.
     * Second click on a different terminal → draws the wire.
     * If the first selection was a junction, same logic applies.
     */
    handleTerminalClick(compId, nodeIndex, node) {
        if (!this.selectedTerminal) {
            this.selectedTerminal = { compId, nodeIndex, node };
            this.render();
            this.log('Terminal selected — click another terminal or junction to connect (ESC to cancel)');
            return;
        }

        const first = this.selectedTerminal;
        this.selectedTerminal = null;

        // Clicked the same terminal again → deselect
        if (first.compId === compId && first.nodeIndex === nodeIndex) {
            this.render();
            return;
        }

        // Prevent same-component connection (only meaningful for real components)
        const firstIsComp  = !first.compId.startsWith('junc-');
        const secondIsComp = !compId.startsWith('junc-');
        if (firstIsComp && secondIsComp && first.compId === compId) {
            this.log('Cannot connect terminals on the same component', 'warning');
            this.render();
            return;
        }

        const existing = super.findWireBetween(first.compId, first.nodeIndex, compId, nodeIndex);
        if (existing) {
            this.deleteWire(existing.id);
            this.updateStats();
            this.log('Wire removed');
        } else {
            const { wire, error } = super.createWire(first.node, node, compId, nodeIndex);
            if (!wire) {
                this.log(error || 'Could not create wire', 'warning');
            } else {
                const fromLabel = first.compId.startsWith('junc-')
                    ? 'Junction'
                    : this.getComponentName(this.components.find(c => c.id === first.compId)?.type);
                const toLabel = compId.startsWith('junc-')
                    ? 'Junction'
                    : this.getComponentName(this.components.find(c => c.id === compId)?.type);
                this.log(`Wire connected: ${fromLabel} → ${toLabel}`);
                this.updateStats();
                if (this.simulationRunning) {
                    const result = super.solveCircuit();
                    this.handleSolverResult(result);
                }
            }
        }

        this.render();
    }

    /**
     * Called when user clicks a junction dot.
     * Behaves like handleTerminalClick but for junction endpoints.
     */
    handleJunctionClick(junctionId) {
        const junction = this.junctions.find(j => j.id === junctionId);
        if (!junction) return;

        const node = { id: `${junctionId}-node`, x: junction.x, y: junction.y, parent: junctionId, index: 0 };
        this.handleTerminalClick(junctionId, 0, node);
    }

    // -------------------------------------------------------------------------
    // Wire click → place junction
    // -------------------------------------------------------------------------

    /**
     * Clicking on a wire while a terminal is NOT selected places a junction at
     * the snapped grid point on the wire and splits the wire.
     * Clicking on a wire while a terminal IS selected places a junction and
     * immediately connects the pending terminal to it.
     */
    handleWireClick(wireId, rawX, rawY) {
        const snappedX = Math.round(rawX / this.gridSize) * this.gridSize;
        const snappedY = Math.round(rawY / this.gridSize) * this.gridSize;

        const junc = super.splitWireAt(wireId, snappedX, snappedY);
        if (!junc) return;

        this.log(`Junction placed at (${snappedX}, ${snappedY})`);
        this.updateStats();

        if (this.selectedTerminal) {
            // Complete the pending wire to the new junction
            this.handleJunctionClick(junc.id);
        } else {
            // Just placed a junction; select it as next wire start
            const node = { id: `${junc.id}-node`, x: junc.x, y: junc.y, parent: junc.id, index: 0 };
            this.selectedTerminal = { compId: junc.id, nodeIndex: 0, node };
            this.log('Junction selected — click another terminal to connect (ESC to cancel)');
        }

        if (this.simulationRunning) {
            const result = super.solveCircuit();
            this.handleSolverResult(result);
        }

        this.render();
    }

    deleteWire(wireId) {
        super.deleteWire(wireId);
        this.updateStats();
        this.render();

        if (this.simulationRunning) {
            const result = super.solveCircuit();
            this.handleSolverResult(result);
        }
    }

    selectWire(wireId) {
        this.selectedWireId = wireId;
        this.selectedId = null;
        this.selectedTerminal = null;
        this.render();
        this.updateInspector();
    }

    deleteComponent(id) {
        super.deleteComponent(id);
        this.updateStats();
        this.render();
        this.updateInspector();
        this.log('Component deleted');

        if (this.simulationRunning) {
            const result = super.solveCircuit();
            this.handleSolverResult(result);
        }
    }

    // -------------------------------------------------------------------------
    // Mouse events
    // -------------------------------------------------------------------------

    handleMouseDown(e) {
        if (e.button !== 0) return;
        const compGroup = e.target.closest('.component-group');
        if (compGroup && !e.target.classList.contains('node-point')) {
            const id = compGroup.dataset.id;
            const comp = this.components.find(c => c.id === id);
            if (!comp) return;
            const pt = this.getSVGPoint(e);
            this.dragState = {
                active: true,
                item: comp,
                offset: { x: pt.x - comp.x, y: pt.y - comp.y }
            };
        }
    }

    handleMouseMove(e) {
        if (!this.dragState.active) return;
        const pt = this.getSVGPoint(e);
        const comp = this.dragState.item;
        if (!comp) return;

        const newX = Math.round((pt.x - this.dragState.offset.x) / this.gridSize) * this.gridSize;
        const newY = Math.round((pt.y - this.dragState.offset.y) / this.gridSize) * this.gridSize;
        const dx = newX - comp.x;
        const dy = newY - comp.y;

        comp.x = newX;
        comp.y = newY;
        comp.nodes.forEach(node => { node.x += dx; node.y += dy; });

        this.wires.forEach(wire => {
            if (wire.fromComp === comp.id) {
                const node = comp.nodes[wire.fromNodeIdx];
                wire.x1 = node.x; wire.y1 = node.y;
            }
            if (wire.toComp === comp.id) {
                const node = comp.nodes[wire.toNodeIdx];
                wire.x2 = node.x; wire.y2 = node.y;
            }
        });

        this.render();
        this.updateInspector();
    }

    handleMouseUp() {
        this.dragState.active = false;
        this.dragState.item = null;
    }

    selectComponent(id) {
        this.selectedId = id;
        this.selectedWireId = null;
        this.updateInspector();
        this.render();
    }

    // -------------------------------------------------------------------------
    // Inspector
    // -------------------------------------------------------------------------

    updateInspector() {
        if (this.selectedWireId) {
            const wire = this.wires.find(w => w.id === this.selectedWireId);
            if (wire) {
                this.inspector.innerHTML = `
                    <div class="inspector-form">
                        <div class="form-group">
                            <label class="form-label">Type</label>
                            <div class="form-value">Wire</div>
                        </div>
                        <div class="form-group">
                            <label class="form-label">Tip</label>
                            <div class="form-value" style="font-size:11px;opacity:0.7;">Click wire to place junction &amp; branch</div>
                        </div>
                        ${this.simulationRunning ? `
                        <div class="calculated-values">
                            <div class="calculated-title">Calculated Values</div>
                            <div class="value-row">
                                <span class="value-label">Current</span>
                                <span class="value-number">${(wire.current * 1000).toFixed(2)} mA</span>
                            </div>
                        </div>` : ''}
                        <button class="delete-btn" onclick="circuit.deleteWire('${wire.id}')">Delete Wire</button>
                    </div>`;
                return;
            }
        }

        if (!this.selectedId) {
            this.inspector.innerHTML = `
                <div class="empty-state">
                    <p class="empty-text">No component selected</p>
                    <div class="system-stats">
                        <div class="stat-row"><span>Status:</span>
                            <span id="sim-status" class="status-badge ${this.simulationRunning ? 'running' : 'stopped'}">
                                ${this.simulationRunning ? 'Running' : 'Stopped'}</span>
                        </div>
                        <div class="stat-row"><span>Components:</span>
                            <span id="stat-components">${this.components.length}</span></div>
                        <div class="stat-row"><span>Wires:</span>
                            <span id="stat-nodes">${this.wires.length}</span></div>
                        <div class="stat-row"><span>Junctions:</span>
                            <span id="stat-junctions">${this.junctions.length}</span></div>
                    </div>
                </div>`;
            return;
        }

        const comp = this.components.find(c => c.id === this.selectedId);
        if (!comp) {
            this.selectedId = null;
            this.inspector.innerHTML = `<div class="empty-state"><p class="empty-text">No component selected</p></div>`;
            return;
        }

        let calculatedSection = '';
        if (this.simulationRunning) {
            const v = comp.voltage || 0;
            const i = comp.current || 0;
            const power = Math.abs(v * i);
            calculatedSection = `
                <div class="calculated-values">
                    <div class="calculated-title">Calculated Values</div>
                    <div class="value-row">
                        <span class="value-label">Voltage Drop</span>
                        <span class="value-number">${v.toFixed(3)} V</span>
                    </div>
                    <div class="value-row">
                        <span class="value-label">Current</span>
                        <span class="value-number">${(i * 1000).toFixed(2)} mA</span>
                    </div>
                    <div class="value-row">
                        <span class="value-label">Power</span>
                        <span class="value-number">${power.toFixed(4)} W</span>
                    </div>
                    ${comp.type === 'B' && power > 0.001
                        ? '<div class="value-row"><span class="value-label">State</span><span class="value-number" style="color:#f59e0b;">💡 Lit</span></div>'
                        : ''}
                </div>`;
        }

        const propertyInput = comp.type === 'B'
            ? `<div class="form-group">
                <label class="form-label">Resistance (Ω)</label>
                <input type="number" class="form-input" id="prop-value" value="${comp.value}" step="10" min="1">
               </div>`
            : `<div class="form-group">
                <label class="form-label">Voltage (V)</label>
                <input type="number" class="form-input" id="prop-value" value="${comp.value}" step="0.5" min="0">
               </div>`;

        this.inspector.innerHTML = `
            <div class="inspector-form">
                <div class="form-group">
                    <label class="form-label">Type</label>
                    <div class="form-value">${this.getComponentName(comp.type)}</div>
                </div>
                <div class="form-group">
                    <label class="form-label">Position</label>
                    <div class="form-value">X: ${comp.x}, Y: ${comp.y}</div>
                </div>
                ${propertyInput}
                ${calculatedSection}
                <button class="delete-btn" onclick="circuit.deleteComponent('${comp.id}')">Delete Component</button>
            </div>`;

        const input = document.getElementById('prop-value');
        if (input) {
            input.addEventListener('input', (e) => {
                comp.value = parseFloat(e.target.value) || 0;
                if (this.simulationRunning) {
                    const result = super.solveCircuit();
                    this.handleSolverResult(result);
                }
                this.updateInspector();
            });
        }
    }

    updateStats() {
        const sc = document.getElementById('stat-components');
        const sn = document.getElementById('stat-nodes');
        const sj = document.getElementById('stat-junctions');
        const ss = document.getElementById('sim-status');
        if (sc) sc.textContent = this.components.length;
        if (sn) sn.textContent = this.wires.length;
        if (sj) sj.textContent = this.junctions.length;
        if (ss) {
            ss.textContent = this.simulationRunning ? 'Running' : 'Stopped';
            ss.className = `status-badge ${this.simulationRunning ? 'running' : 'stopped'}`;
        }
    }

    startSimulation() {
        if (this.components.length === 0) {
            this.log('No components in circuit', 'error');
            return;
        }
        this.simulationRunning = true;
        document.getElementById('btn-run').disabled = true;
        document.getElementById('btn-stop').disabled = false;
        const sd = document.getElementById('status-display');
        if (sd) { sd.textContent = 'Running'; sd.className = 'status-display running'; }
        this.log('Simulation started', 'success');

        const result = super.solveCircuit();
        this.handleSolverResult(result);
        this.animate();
    }

    stopSimulation() {
        this.simulationRunning = false;
        this.shortCircuit = false;
        this._clearShortCircuitFlash();

        document.getElementById('btn-run').disabled = false;
        document.getElementById('btn-stop').disabled = true;
        const sd = document.getElementById('status-display');
        if (sd) { sd.textContent = 'Stopped'; sd.className = 'status-display'; }
        if (this.currentAnimationId) cancelAnimationFrame(this.currentAnimationId);

        this.components.forEach(c => { c.current = 0; c.voltage = 0; });
        this.wires.forEach(w => { w.current = 0; });

        this.render();
        this.updateInspector();
        this.log('Simulation stopped');
    }

    stepSimulation() {
        const result = super.solveCircuit();
        this.handleSolverResult(result);
        this.render();
        this.updateInspector();
    }

    animate() {
        if (!this.simulationRunning) return;
        this.render();
        this.currentAnimationId = requestAnimationFrame(() => this.animate());
    }

    // -------------------------------------------------------------------------
    // Render
    // -------------------------------------------------------------------------

    render() {
        this.componentsLayer.innerHTML = '';
        this.wiresLayer.innerHTML = '';
        this.currentsLayer.innerHTML = '';
        if (this.tempWireLayer) this.tempWireLayer.style.display = 'none';

        // --- Wires ---
        this.wires.forEach(wire => {
            const line = document.createElementNS('http://www.w3.org/2000/svg', 'line');
            line.setAttribute('x1', wire.x1);
            line.setAttribute('y1', wire.y1);
            line.setAttribute('x2', wire.x2);
            line.setAttribute('y2', wire.y2);
            line.setAttribute('class', 'wire-line');
            if (wire.id === this.selectedWireId) line.classList.add('selected');
            line.dataset.wireId = wire.id;

            line.addEventListener('click', (e) => {
                e.stopPropagation();
                const pt = this.getSVGPoint(e);

                if (this.selectedTerminal) {
                    // User has a pending terminal selected — clicking wire places junction + connects
                    this.handleWireClick(wire.id, pt.x, pt.y);
                } else {
                    // No pending selection: select the wire (next click on same wire would place junction)
                    this.selectWire(wire.id);
                }
            });

            // Double-click always places a junction
            line.addEventListener('dblclick', (e) => {
                e.stopPropagation();
                const pt = this.getSVGPoint(e);
                this.selectedWireId = null;
                this.selectedTerminal = null;
                this.handleWireClick(wire.id, pt.x, pt.y);
            });

            this.wiresLayer.appendChild(line);

            if (this.simulationRunning && Math.abs(wire.current) > 0.0001) {
                this.renderCurrentIndicator(wire);
            }
        });

        // --- Junctions ---
        this.junctions.forEach(junc => {
            const isSelected = this.selectedTerminal?.compId === junc.id;

            const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            circle.setAttribute('cx', junc.x);
            circle.setAttribute('cy', junc.y);
            circle.setAttribute('r', isSelected ? 9 : 6);
            circle.setAttribute('class', `junction-point${isSelected ? ' junction-selected' : ''}`);
            circle.dataset.junctionId = junc.id;

            circle.addEventListener('click', (e) => {
                e.stopPropagation();
                this.handleJunctionClick(junc.id);
            });

            this.wiresLayer.appendChild(circle);
        });

        // --- Components ---
        this.components.forEach(comp => {
            const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
            g.setAttribute('class', `component-group${comp.id === this.selectedId ? ' selected' : ''}`);
            g.setAttribute('data-id', comp.id);
            g.setAttribute('data-type', comp.type);
            g.style.transform = `translate(${comp.x}px, ${comp.y}px)`;

            const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
            rect.setAttribute('x', -20);
            rect.setAttribute('y', -20);
            rect.setAttribute('width', 40);
            rect.setAttribute('height', 40);

            let rectClass = 'component-rect';
            if (comp.type === 'B' && this.simulationRunning) {
                const power = Math.abs((comp.voltage || 0) * (comp.current || 0));
                if (power > 0.001) rectClass += ' lit';
            }
            if (comp.type === 'V' && this.shortCircuit && this._shortCircuitFlash) {
                rectClass += ' short-circuit';
            }
            rect.setAttribute('class', rectClass);

            rect.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedTerminal = null;
                this.selectComponent(comp.id);
            });

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'component-text');
            text.textContent = comp.type;

            g.appendChild(rect);
            g.appendChild(text);

            comp.nodes.forEach((node, idx) => {
                const isSelected = this.selectedTerminal &&
                    this.selectedTerminal.compId === comp.id &&
                    this.selectedTerminal.nodeIndex === idx;
                const wiresHere = super.findWiresAtTerminal(comp.id, idx);
                const occupied  = wiresHere.length > 0;

                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', node.x - comp.x);
                circle.setAttribute('cy', node.y - comp.y);
                circle.setAttribute('r', isSelected ? 8 : 5);

                let nodeClass = 'node-point';
                if (isSelected) nodeClass += ' terminal-selected';
                if (occupied)   nodeClass += ' terminal-occupied';
                circle.setAttribute('class', nodeClass);

                circle.dataset.nodeId    = node.id;
                circle.dataset.compId    = comp.id;
                circle.dataset.nodeIndex = idx;

                circle.addEventListener('click', (e) => {
                    e.stopPropagation();
                    this.handleTerminalClick(comp.id, idx, node);
                });

                g.appendChild(circle);
            });

            this.componentsLayer.appendChild(g);
        });
    }

    // -------------------------------------------------------------------------
    // Current animation
    // -------------------------------------------------------------------------

    renderCurrentIndicator(wire) {
        const DOTS  = 4;
        const speed = Math.min(Math.abs(wire.current) * 1500 + 0.4, 2.5);
        const now   = performance.now() / 1000;
        const dir   = wire.current >= 0 ? 1 : -1;

        for (let i = 0; i < DOTS; i++) {
            let t = ((now * speed * dir + i / DOTS) % 1 + 1) % 1;

            const x = wire.x1 + (wire.x2 - wire.x1) * t;
            const y = wire.y1 + (wire.y2 - wire.y1) * t;

            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('r', 3);
            dot.setAttribute('class', 'current-indicator');
            dot.setAttribute('cx', x);
            dot.setAttribute('cy', y);
            this.currentsLayer.appendChild(dot);
        }
    }

    // -------------------------------------------------------------------------
    // Short circuit flash
    // -------------------------------------------------------------------------

    _triggerShortCircuitFlash() {
        this._clearShortCircuitFlash();
        let flashes = 0;
        const maxFlashes = 6;
        const toggle = () => {
            if (!this.shortCircuit || flashes >= maxFlashes) {
                this._shortCircuitFlash = false;
                this.render();
                return;
            }
            this._shortCircuitFlash = !this._shortCircuitFlash;
            flashes++;
            this.render();
            this._shortCircuitFlashTimer = setTimeout(toggle, 150);
        };
        this._shortCircuitFlash = true;
        toggle();
    }

    _clearShortCircuitFlash() {
        if (this._shortCircuitFlashTimer) {
            clearTimeout(this._shortCircuitFlashTimer);
            this._shortCircuitFlashTimer = null;
        }
        this._shortCircuitFlash = false;
    }

    // -------------------------------------------------------------------------
    // Solver result handler
    // -------------------------------------------------------------------------

    handleSolverResult(result) {
        if (!result.success) {
            if (result.shortCircuit) {
                this._triggerShortCircuitFlash();
            }
            this.log(result.message, 'warning');
        } else {
            this.shortCircuit = false;
            this._clearShortCircuitFlash();
            this.log(result.message, 'success');
        }
        this.updateInspector();
        this.updateStats();
    }

    log(message, type = 'info') {
        const entry = document.createElement('div');
        entry.className = `log-entry ${type}`;
        entry.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
        this.logContent.appendChild(entry);
        this.logContent.scrollTop = this.logContent.scrollHeight;
    }
}

const circuit = new CircuitEngine();

function getComponentName(type) {
    switch (type) {
        case 'R': return 'Resistor';
        case 'C': return 'Capacitor';
        case 'L': return 'Inductor';
        case 'V': return 'Voltage Source';
        case 'B': return 'Bulb';
        default:  return 'Component';
    }
}

function generateId(prefix) {
    return `${prefix}-${Math.random().toString(36).substr(2, 9)}`;
}
