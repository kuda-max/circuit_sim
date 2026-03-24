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

        this.init();
    }

    init() {
        this.setupEventListeners();
        this.setupDragAndDrop();
        this.updateStats();
        this.log('Circuit Engine ready — click terminals to connect');
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

    handleTerminalClick(compId, nodeIndex, node) {
        if (!this.selectedTerminal) {
            this.selectedTerminal = { compId, nodeIndex, node };
            this.render();
            this.log('Terminal selected — click another terminal to connect (ESC to cancel)');
            return;
        }

        const first = this.selectedTerminal;
        this.selectedTerminal = null;

        if (first.compId === compId) {
            this.log('Cannot connect terminals on the same component', 'warning');
            this.render();
            return;
        }

        const existing = super.findWireBetween(first.compId, first.nodeIndex, compId, nodeIndex);
        if (existing) {
            this.deleteWire(existing.id);
            this.log('Wire removed');
        } else {
            const wire = super.createWire(first.node, node, compId, nodeIndex);
            if (!wire) return;
            this.log(`Wire connected: ${this.getComponentName(this.components.find(c => c.id === first.compId)?.type)} → ${this.getComponentName(this.components.find(c => c.id === compId)?.type)}`);
            this.updateStats();
            if (this.simulationRunning) {
                const result = super.solveCircuit();
                this.handleSolverResult(result);
            }
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
        this.render();
        this.updateInspector();
    }

    handleMouseDown(e) {
        if (e.button !== 0) return;
        const compGroup = e.target.closest('.component-group');
        if (compGroup && !e.target.classList.contains('node-point')) {
            const id = compGroup.dataset.id;
            const comp = this.components.find(c => c.id === id);
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

    deleteComponent(id) {
        super.deleteComponent(id);
        this.render();
        this.updateStats();
        this.log('Component deleted');

        if (this.simulationRunning) {
            const result = super.solveCircuit();
            this.handleSolverResult(result);
        }
    }

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
                    </div>
                </div>`;
            return;
        }

        const comp = this.components.find(c => c.id === this.selectedId);
        if (!comp) return;

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
        const ss = document.getElementById('sim-status');
        if (sc) sc.textContent = this.components.length;
        if (sn) sn.textContent = this.wires.length;
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

    render() {
        this.componentsLayer.innerHTML = '';
        this.wiresLayer.innerHTML = '';
        this.currentsLayer.innerHTML = '';
        if (this.tempWireLayer) this.tempWireLayer.style.display = 'none';

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
                this.selectWire(wire.id);
            });

            this.wiresLayer.appendChild(line);

            if (this.simulationRunning && Math.abs(wire.current) > 0.0001) {
                this.renderCurrentIndicator(wire);
            }
        });

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
            rect.setAttribute('class', 'component-rect');

            rect.addEventListener('click', (e) => {
                e.stopPropagation();
                this.selectedTerminal = null;
                this.selectComponent(comp.id);
            });

            const text = document.createElementNS('http://www.w3.org/2000/svg', 'text');
            text.setAttribute('class', 'component-text');
            text.textContent = comp.type;

            if (comp.type === 'B' && this.simulationRunning) {
                const power = Math.abs((comp.voltage || 0) * (comp.current || 0));
                if (power > 0.001) {
                    rect.setAttribute('class', 'component-rect lit');
                }
            }

            g.appendChild(rect);
            g.appendChild(text);

            comp.nodes.forEach((node, idx) => {
                const isSelected = this.selectedTerminal &&
                    this.selectedTerminal.compId === comp.id &&
                    this.selectedTerminal.nodeIndex === idx;

                const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
                circle.setAttribute('cx', node.x - comp.x);
                circle.setAttribute('cy', node.y - comp.y);
                circle.setAttribute('r', isSelected ? 8 : 5);
                circle.setAttribute('class', 'node-point' + (isSelected ? ' terminal-selected' : ''));
                circle.dataset.nodeId = node.id;
                circle.dataset.compId = comp.id;
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

    renderCurrentIndicator(wire) {
        const steps = 4;
        const current = wire.current;
        const speed = Math.min(Math.abs(current) * 2, 3);
        const direction = current > 0 ? 1 : -1;

        for (let i = 0; i < steps; i++) {
            const dot = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
            dot.setAttribute('r', 3);
            dot.setAttribute('class', 'current-indicator');

            const t = ((Date.now() / 1000 * speed * direction) + i / steps) % 1;
            const offset = t < 0 ? t + 1 : t;
            const x = wire.x1 + (wire.x2 - wire.x1) * offset;
            const y = wire.y1 + (wire.y2 - wire.y1) * offset;

            dot.setAttribute('cx', x);
            dot.setAttribute('cy', y);
            this.currentsLayer.appendChild(dot);
        }
    }

    handleSolverResult(result) {
        if (!result.success) {
            this.log(result.message, 'warning');
        } else {
            this.log(result.message, 'success');
        }
        this.updateInspector();
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
