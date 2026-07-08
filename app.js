// --- Application Global Data Coordinates ---
let appState = {
    left: { raw: { time: [], fsr1: [], fsr2: [] }, events: [], metrics: {} },
    right: { raw: { time: [], fsr1: [], fsr2: [] }, events: [], metrics: {} },
    activeSide: 'left'
};

// --- Event Listeners Hooks ---
document.getElementById('csvFileInput').addEventListener('change', handleFileImport);
document.getElementById('showLeftBtn').addEventListener('click', () => switchView('left'));
document.getElementById('showRightBtn').addEventListener('click', () => switchView('right'));

function handleFileImport(e) {
    const file = e.target.files[0];
    if (!file) return;

    document.getElementById('fileStatus').innerText = "Loading and processing: " + file.name;
    
    const reader = new FileReader();
    reader.onload = function(evt) {
        try {
            parseAndProcessGaitData(evt.target.result);
            document.getElementById('fileStatus').innerText = "Loaded: " + file.name;
            document.getElementById('exportBtn').removeAttribute('disabled');
        } catch (err) {
            alert("Error parsing structural alignment values: " + err.message);
            document.getElementById('fileStatus').innerText = "Data Processing Failure";
        }
    };
    reader.readAsText(file);
}

// --- CSV Extraction Core Processing ---
function parseAndProcessGaitData(csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length < 2) throw new Error("Target file lacks time-series data records.");

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const idxDevice = headers.indexOf('deviceid');
    const idxRxTime = headers.indexOf('rxtime');
    const idxFsr1 = headers.indexOf('fsr1');
    const idxFsr2 = headers.indexOf('fsr2');

    // Reset runtime containers
    appState.left.raw = { time: [], fsr1: [], fsr2: [] };
    appState.right.raw = { time: [], fsr1: [], fsr2: [] };

    // Group rows by device sequence indexes
    for (let i = 1; i < lines.length; i++) {
        const row = lines[i].split(',');
        if (row.length < headers.length) continue;

        const devId = parseInt(row[idxDevice]);
        const rxTime = parseFloat(row[idxRxTime]);
        const fsr1 = parseFloat(row[idxFsr1]);
        const fsr2 = parseFloat(row[idxFsr2]);

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

    // Process coordinates and calculate metrics for both feet
    ['left', 'right'].forEach(side => {
        const data = appState[side].raw;
        if (data.time.length === 0) return;

        // Zero-align structural time vectors to seconds
        const t0 = data.time[0];
        data.time = data.time.map(t => (t - t0) / 1000.0);

        // Run gait analysis pipeline
        appState[side].events = runEventDetection(data);
        appState[side].metrics = calculateGaitMetrics(data, appState[side].events);
    });

    updateMetricsTable();
    renderPlotView();
}

// --- Digital Processing Analytics (Mirroring event_detection.py) ---
function runEventDetection(data) {
    let events = [];
    if (data.time.length === 0) return events;

    // Adaptive 20% rule thresholds
    const getThreshold = (arr) => {
        const min = Math.min(...arr);
        const max = Math.max(...arr);
        return min + 0.20 * (max - min);
    };

    const th1 = getThreshold(data.fsr1); // Toe Threshold
    const th2 = getThreshold(data.fsr2); // Heel Threshold

    // Detect crossings chronologically
    for (let i = 1; i < data.time.length; i++) {
        // Heel Strike: FSR2 rising edge crossing threshold
        if (data.fsr2[i-1] <= th2 && data.fsr2[i] > th2) {
            events.push({ time: data.time[i], index: i, type: 'Heel Strike' });
        }
        // Toe Off: FSR1 falling edge crossing threshold
        if (data.fsr1[i-1] > th1 && data.fsr1[i] <= th1) {
            events.push({ time: data.time[i], index: i, type: 'Toe Off' });
        }
    }
    return events.sort((a, b) => a.time - b.time);
}

// --- Temporal Parametric Metrics (Mirroring gait_parameters.py) ---
function calculateGaitMetrics(data, events) {
    const totalDuration = data.time[data.time.length - 1] - data.time[0];
    const heelStrikes = events.filter(e => e.type === 'Heel Strike');
    const stepCount = heelStrikes.length;
    const cadence = totalDuration > 0 ? (stepCount / totalDuration) * 60.0 : 0;

    // Estimate mean stance phase duration
    let stanceDurations = [];
    for (let i = 0; i < events.length - 1; i++) {
        if (events[i].type === 'Heel Strike' && events[i+1].type === 'Toe Off') {
            const dt = events[i+1].time - events[i].time;
            if (dt > 0 && dt < 3.0) stanceDurations.push(dt); 
        }
    }
    const meanStance = stanceDurations.length > 0 ? 
        (stanceDurations.reduce((a, b) => a + b, 0) / stanceDurations.length) : 0;

    return {
        steps: stepCount,
        cadence: cadence.toFixed(1),
        stance: meanStance.toFixed(3),
        duration: totalDuration.toFixed(2)
    };
}

// --- UI Rendering Sync Functions ---
function updateMetricsTable() {
    ['left', 'right'].forEach(side => {
        const m = appState[side].metrics;
        if (!m.steps && m.steps !== 0) return;
        
        document.getElementById(`${side.charAt(0)}-steps`).innerText = m.steps;
        document.getElementById(`${side.charAt(0)}-cadence`).innerText = m.cadence;
        document.getElementById(`${side.charAt(0)}-stance`).innerText = m.stance + " s";
        document.getElementById(`${side.charAt(0)}-duration`).innerText = m.duration + " s";
    });
}

function switchView(side) {
    appState.activeSide = side;
    document.getElementById('showLeftBtn').classList.toggle('active', side === 'left');
    document.getElementById('showRightBtn').classList.toggle('active', side === 'right');
    renderPlotView();
}

function renderPlotView() {
    const side = appState.activeSide;
    const data = appState[side].raw;
    if (data.time.length === 0) return;

    // Focus viewport window size constraint match
    const maxSamples = Math.min(1200, data.time.length);
    const tWindow = data.time.slice(0, maxSamples);
    const fsr1Window = data.fsr1.slice(0, maxSamples);
    const fsr2Window = data.fsr2.slice(0, maxSamples);

    const traceToe = {
        x: tWindow, y: fsr1Window,
        mode: 'lines', name: 'FSR1 (Toe)',
        line: { color: '#FF5555', width: 2 }
    };

    const traceHeel = {
        x: tWindow, y: fsr2Window,
        mode: 'lines', name: 'FSR2 (Heel)',
        line: { color: '#FFCC00', width: 2 }
    };

    // Compile dynamic shapes to represent vertical event lines
    const windowMaxTime = tWindow[tWindow.length - 1];
    const filteredEvents = appState[side].events.filter(e => e.time <= windowMaxTime);
    
    const shapes = filteredEvents.map(ev => ({
        type: 'line',
        x0: ev.time, x1: ev.time,
        y0: 0, y1: Math.max(...fsr1Window, ...fsr2Window),
        line: {
            color: ev.type === 'Heel Strike' ? '#55FF55' : '#00BFFF',
            width: 1.5,
            dash: 'dashdot'
        }
    }));

    const layout = {
        title: `${side.toUpperCase()} FOOT Signal Traces and Logged Gait Boundaries`,
        paper_bgcolor: '#1e1e1e',
        plot_bgcolor: '#1e1e1e',
        font: { color: '#ffffff' },
        xaxis: { title: 'Relative Timeline Axis (Seconds)', gridcolor: '#333' },
        yaxis: { title: 'Sensor Amplitude Quantization (Raw Units)', gridcolor: '#333' },
        shapes: shapes,
        legend: { orientation: 'h', y: -0.2 }
    };

    Plotly.newPlot('chartViewport', [traceToe, traceHeel], layout, { responsive: true });
}
