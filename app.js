let appState = {
    left: { raw: { time: [], fsr1: [], fsr2: [] }, events: [], phases: [], metrics: {} },
    right: { raw: { time: [], fsr1: [], fsr2: [] }, events: [], phases: [], metrics: {} },
    activeSide: 'left',
    thresholds: { fsr1: 500, fsr2: 500 },
    isAuto: true
};

// --- DOM Hooks ---
document.getElementById('csvFileInput').addEventListener('change', handleFileImport);
document.getElementById('showLeftBtn').addEventListener('click', () => switchView('left'));
document.getElementById('showRightBtn').addEventListener('click', () => switchView('right'));

const th1Slider = document.getElementById('th1Slider');
const th2Slider = document.getElementById('th2Slider');

th1Slider.addEventListener('input', (e) => handleSliderChange('fsr1', parseInt(e.target.value)));
th2Slider.addEventListener('input', (e) => handleSliderChange('fsr2', parseInt(e.target.value)));
document.getElementById('resetAutoBtn').addEventListener('click', resetToAdaptive);

function handleSliderChange(type, val) {
    appState.isAuto = false;
    appState.thresholds[type] = val;
    document.getElementById(type === 'fsr1' ? 'th1Val' : 'th2Val').innerText = val;
    recalculatePipeline();
}

function resetToAdaptive() {
    appState.isAuto = true;
    recalculatePipeline();
}

function handleFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        parseCSV(evt.target.result);
        recalculatePipeline();
    };
    reader.readAsText(file);
}

function parseCSV(csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    
    appState.left.raw = { time: [], fsr1: [], fsr2: [] };
    appState.right.raw = { time: [], fsr1: [], fsr2: [] };

    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < headers.length) continue;

        const devId = parseInt(row[headers.indexOf('deviceid')]);
        const rxTime = parseFloat(row[headers.indexOf('rxtime')]);
        const fsr1 = parseFloat(row[headers.indexOf('fsr1')]);
        const fsr2 = parseFloat(row[headers.indexOf('fsr2')]);

        if (devId === 1) {
            appState.left.raw.time.push(rxTime);
            appState.left.raw.fsr1.push(fsr1);
            appState.left.raw.fsr2.push(fsr2);
        } else if (devId === 2) {
            appState.right.raw.time.push(rxTime);
            appState.right.raw.fsr1.push(fsr1);
            appState.right.raw.fsr2.push(fsr2);
        }
    }

    ['left', 'right'].forEach(side => {
        const d = appState[side].raw;
        if (d.time.length > 0) {
            const t0 = d.time[0];
            d.time = d.time.map(t => (t - t0) / 1000.0);
        }
    });
}

function recalculatePipeline() {
    if (appState.left.raw.time.length === 0 && appState.right.raw.time.length === 0) return;

    if (appState.isAuto) {
        // Calculate adaptive 20% thresholds from the active side
        const activeData = appState[appState.activeSide].raw;
        const calcAdaptive = (arr) => {
            const min = Math.min(...arr);
            const max = Math.max(...arr);
            return Math.round(min + 0.20 * (max - min));
        };
        appState.thresholds.fsr1 = calcAdaptive(activeData.fsr1);
        appState.thresholds.fsr2 = calcAdaptive(activeData.fsr2);

        // Update Slider UI positions without triggering listeners
        th1Slider.value = appState.thresholds.fsr1;
        th2Slider.value = appState.thresholds.fsr2;
        document.getElementById('th1Val').innerText = appState.thresholds.fsr1;
        document.getElementById('th2Val').innerText = appState.thresholds.fsr2;
    }

    // Process both streams using current thresholds
    ['left', 'right'].forEach(side => {
        const data = appState[side].raw;
        if (data.time.length === 0) return;

        // 1. Core Event Crossings Logic
        let events = [];
        for (let i = 1; i < data.time.length; i++) {
            if (data.fsr2[i-1] <= appState.thresholds.fsr2 && data.fsr2[i] > appState.thresholds.fsr2) {
                events.push({ time: data.time[i], index: i, type: 'Heel Strike' });
            }
            if (data.fsr2[i-1] > appState.thresholds.fsr2 && data.fsr2[i] <= appState.thresholds.fsr2) {
                events.push({ time: data.time[i], index: i, type: 'Heel Off' });
            }
            if (data.fsr1[i-1] <= appState.thresholds.fsr1 && data.fsr1[i] > appState.thresholds.fsr1) {
                events.push({ time: data.time[i], index: i, type: 'Foot Flat' });
            }
            if (data.fsr1[i-1] > appState.thresholds.fsr1 && data.fsr1[i] <= appState.thresholds.fsr1) {
                events.push({ time: data.time[i], index: i, type: 'Toe Off' });
            }
        }
        appState[side].events = events.sort((a, b) => a.time - b.time);

        // 2. Map Categorical Phase States
        let phases = [];
        for (let i = 0; i < data.time.length; i++) {
            const h = data.fsr2[i] > appState.thresholds.fsr2;
            const t = data.fsr1[i] > appState.thresholds.fsr1;
            phases.push(h && !t ? 'Heel Contact' : h && t ? 'Foot Flat' : !h && t ? 'Forefoot Contact' : 'Swing');
        }
        appState[side].phases = phases;

        // 3. Compute Structural Durations
        const duration = data.time[data.time.length - 1] - data.time[0];
        const steps = events.filter(e => e.type === 'Heel Strike').length;
        const cadence = duration > 0 ? (steps / duration) * 60.0 : 0;

        let stanceDurations = [];
        for (let i = 0; i < events.length - 1; i++) {
            if (events[i].type === 'Heel Strike' && events[i+1].type === 'Toe Off') {
                stanceDurations.push(events[i+1].time - events[i].time);
            }
        }
        const meanStance = stanceDurations.length > 0 ? (stanceDurations.reduce((a,b)=>a+b,0)/stanceDurations.length) : 0;

        const getPhaseTime = (pName) => {
            let count = 0;
            phases.forEach(p => { if(p === pName) count++; });
            return (count / phases.length) * duration; 
        };

        appState[side].metrics = {
            steps, cadence, duration,
            stance: meanStance,
            contact: ((phases.filter(p => p !== 'Swing').length) / phases.length) * duration,
            heelContact: getPhaseTime('Heel Contact'),
            forefootContact: getPhaseTime('Forefoot Contact')
        };
    });

    updateUIDisplays();
}

function updateUIDisplays() {
    ['left', 'right'].forEach(side => {
        const m = appState[side].metrics;
        if (m.steps === undefined) return;
        document.getElementById(`${side.charAt(0)}-steps`).innerText = m.steps;
        document.getElementById(`${side.charAt(0)}-cadence`).innerText = m.cadence.toFixed(1);
        document.getElementById(`${side.charAt(0)}-stance`).innerText = m.stance.toFixed(3);
        document.getElementById(`${side.charAt(0)}-contact`).innerText = m.contact.toFixed(3);
        document.getElementById(`${side.charAt(0)}-h-contact`).innerText = m.heelContact.toFixed(3);
        document.getElementById(`${side.charAt(0)}-ff-contact`).innerText = m.forefootContact.toFixed(3);
        document.getElementById(`${side.charAt(0)}-duration`).innerText = m.duration.toFixed(2);
    });

    // Calculate Symmetry Indices (SI)
    const l = appState.left.metrics;
    const r = appState.right.metrics;
    if (l.steps !== undefined && r.steps !== undefined) {
        const calcSI = (v1, v2) => (v1 + v2) === 0 ? 0 : (Math.abs(v1 - v2) / (0.5 * (v1 + v2))) * 100;
        document.getElementById('si-cadence').innerText = calcSI(l.cadence, r.cadence).toFixed(2) + " %";
        document.getElementById('si-stance').innerText = calcSI(l.stance, r.stance).toFixed(2) + " %";
    }

    renderPlotView();
}

function switchView(side) {
    appState.activeSide = side;
    document.getElementById('showLeftBtn').classList.toggle('active', side === 'left');
    document.getElementById('showRightBtn').classList.toggle('active', side === 'right');
    recalculatePipeline();
}

function renderPlotView() {
    const side = appState.activeSide;
    const data = appState[side].raw;
    if (data.time.length === 0) return;

    const windowSamples = Math.min(1200, data.time.length);
    const tW = data.time.slice(0, windowSamples);

    const traceToe = { x: tW, y: data.fsr1.slice(0, windowSamples), mode: 'lines', name: 'FSR1 (Toe)', line: { color: '#FF5555' } };
    const traceHeel = { x: tW, y: data.fsr2.slice(0, windowSamples), mode: 'lines', name: 'FSR2 (Heel)', line: { color: '#FFCC00' } };

    const maxVal = Math.max(...data.fsr1.slice(0, windowSamples), ...data.fsr2.slice(0, windowSamples));
    const windowMaxTime = tW[tW.length - 1];

    // Create horizontal custom threshold lines matching state parameters
    let shapes = [
        { type: 'line', x0: 0, x1: windowMaxTime, y0: appState.thresholds.fsr1, y1: appState.thresholds.fsr1, line: { color: '#FF5555', width: 1.5, dash: 'dash' } },
        { type: 'line', x0: 0, x1: windowMaxTime, y0: appState.thresholds.fsr2, y1: appState.thresholds.fsr2, line: { color: '#FFCC00', width: 1.5, dash: 'dash' } }
    ];

    // Add vertical event dashes
    appState[side].events.filter(e => e.time <= windowMaxTime).forEach(ev => {
        shapes.push({
            type: 'line', x0: ev.time, x1: ev.time, y0: 0, y1: maxVal,
            line: { color: ev.type === 'Heel Strike' ? '#55FF55' : ev.type === 'Toe Off' ? '#00BFFF' : '#777', width: 1, dash: 'dot' }
        });
    });

    const layout = {
        title: `${side.toUpperCase()} FOOT Real-Time Analysis Window Viewport`,
        paper_bgcolor: '#1e1e1e', plot_bgcolor: '#1e1e1e', font: { color: '#ffffff' },
        xaxis: { title: 'Time (Seconds)', gridcolor: '#2a2a2a' },
        yaxis: { title: 'Sensor Values', gridcolor: '#2a2a2a' },
        shapes: shapes,
        margin: { t: 50, b: 50, l: 60, r: 20 }
    };

    Plotly.newPlot('chartViewport', [traceToe, traceHeel], layout, { responsive: true });
}
