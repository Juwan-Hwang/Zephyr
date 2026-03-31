/**
 * Traffic Chart Module
 * Handles real-time traffic visualization with smooth area charts
 * Completely independent - no external dependencies from ui.js
 */

// Chart state
let trafficHistory = [];
const MAX_DATA_POINTS = 60; // 1 minute of data if 1s interval

// DOM references (initialized on first use)
let canvas = null;
let ctx = null;

// Resize handling
let _chartResizeHandler = null;
let _chartResizeObserver = null;
let _chartFrameId = null;
let _chartResizeDebounce = null;

/**
 * Initialize the traffic chart
 */
export function initChart() {
    canvas = document.getElementById('trafficChart');
    if (!canvas) return;
    ctx = canvas.getContext('2d');
    if (!ctx) return;
    
    // Clean up existing listeners
    if (_chartResizeHandler) {
        window.removeEventListener('resize', _chartResizeHandler);
    }
    if (_chartResizeObserver) {
        _chartResizeObserver.disconnect();
    }
    
    const resize = () => {
        // Clear any pending resize
        if (_chartResizeDebounce) {
            clearTimeout(_chartResizeDebounce);
        }
        
        // Debounce resize to prevent performance issues during window resize
        _chartResizeDebounce = setTimeout(() => {
            const dpr = window.devicePixelRatio || 1;
            const rect = canvas.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) return;
            
            canvas.width = rect.width * dpr;
            canvas.height = rect.height * dpr;
            ctx.setTransform(1, 0, 0, 1, 0, 0);
            ctx.scale(dpr, dpr);
            renderChart();
        }, 100); // 100ms debounce
    };
    
    _chartResizeHandler = resize;
    window.addEventListener('resize', resize);
    
    _chartResizeObserver = new ResizeObserver(resize);
    _chartResizeObserver.observe(canvas.parentElement || canvas);
    
    resize();
}

/**
 * Update traffic data with new values
 * @param {Object} data - Traffic data object
 * @param {string} data.up - Upload speed formatted string (e.g., "10 KB/s")
 * @param {string} data.down - Download speed formatted string
 * @param {Object} data.raw - Raw values
 * @param {number} data.raw.up - Upload speed in bytes/s
 * @param {number} data.raw.down - Download speed in bytes/s
 */
export function updateTrafficData(data) {
    trafficHistory.push({
        up: data.raw.up,
        down: data.raw.down,
        time: Date.now()
    });
    
    if (trafficHistory.length > MAX_DATA_POINTS) {
        trafficHistory.shift();
    }
    
    if (_chartFrameId !== null) {
        cancelAnimationFrame(_chartFrameId);
    }
    _chartFrameId = requestAnimationFrame(() => {
        _chartFrameId = null;
        renderChart();
    });
    
    // Update text display
    const upValEl = document.getElementById('speed-up-val');
    const upUnitEl = document.getElementById('speed-up-unit');
    const downValEl = document.getElementById('speed-down-val');
    const downUnitEl = document.getElementById('speed-down-unit');
    
    if (upValEl && upUnitEl) {
        const parts = data.up.split(' ');
        upValEl.textContent = parts[0] || '0';
        upUnitEl.textContent = parts[1] || 'KB/s';
    }
    if (downValEl && downUnitEl) {
        const parts = data.down.split(' ');
        downValEl.textContent = parts[0] || '0';
        downUnitEl.textContent = parts[1] || 'KB/s';
    }
}

/**
 * Clear traffic history
 */
export function clearTrafficHistory() {
    trafficHistory = [];
    renderChart();
}

/**
 * Render the chart
 */
function renderChart() {
    if (!canvas || !ctx) return;
    
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    
    ctx.clearRect(0, 0, width, height);
    
    if (trafficHistory.length < 2) return;
    
    // Ensure we handle non-numeric values gracefully
    const validData = trafficHistory.filter(d => !isNaN(d.up) && !isNaN(d.down));
    if (validData.length < 2) return;

    // Use a minimum scale of 10KB/s
    let maxVal = Math.max(...validData.map(d => Math.max(d.up, d.down)));
    maxVal = Math.max(maxVal, 1024 * 10); 
    
    const getX = (index) => (index / (MAX_DATA_POINTS - 1)) * width;
    const getY = (val) => height - (val / maxVal) * (height - 20) - 10;

    // Draw Downstream (Purple Gradient)
    drawArea(trafficHistory.map(d => d.down || 0), 'rgba(139, 92, 246, 0.3)', 'rgba(139, 92, 246, 0.8)', getY);
    
    // Draw Upstream (Blue Gradient)
    drawArea(trafficHistory.map(d => d.up || 0), 'rgba(59, 130, 246, 0.3)', 'rgba(59, 130, 246, 0.8)', getY);
}

/**
 * Draw a filled area with smooth curves
 */
function drawArea(data, fillStart, strokeColor, getY) {
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const getX = (index) => (index / (MAX_DATA_POINTS - 1)) * width;
    
    ctx.beginPath();
    ctx.moveTo(getX(0), getY(data[0]));
    
    for (let i = 1; i < data.length; i++) {
        const x1 = getX(i - 1);
        const y1 = getY(data[i - 1]);
        const x2 = getX(i);
        const y2 = getY(data[i]);
        
        // Quadratic curve for smoothness
        const xc = (x1 + x2) / 2;
        const yc = (y1 + y2) / 2;
        ctx.quadraticCurveTo(x1, y1, xc, yc);
    }
    
    // Line style
    ctx.strokeStyle = strokeColor;
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
    
    // Fill style
    const gradient = ctx.createLinearGradient(0, 0, 0, height);
    gradient.addColorStop(0, fillStart);
    gradient.addColorStop(1, 'rgba(255, 255, 255, 0)');
    
    ctx.lineTo(getX(data.length - 1), height);
    ctx.lineTo(getX(0), height);
    ctx.closePath();
    ctx.fillStyle = gradient;
    ctx.fill();
}
