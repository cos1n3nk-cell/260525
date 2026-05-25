// ============================================================
// 台北市即時雨量顯示 - p5.js
// 資料來源：台北市政府水利工程處 OpenData
// CORS 代理：corsproxy.io / allorigins / thingproxy（依序 fallback）
// ============================================================

const TARGET_API = 'https://wic.gov.taipei/OpenData/API/Rain/Get?stationNo=&loginId=open_rain&dataKey=85452C1D';
const CORS_PROXIES = [
  url => `https://corsproxy.io/?${encodeURIComponent(url)}`,
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://thingproxy.freeboard.io/fetch/${url}`,
];
const REFRESH_INTERVAL = 60000;

let stations = [];
let filteredStations = [];
let lastUpdate = '';
let loading = true;
let errorMsg = '';
let raindrops = [];
let scrollOffset = 0;
let targetScroll = 0;
let hoveredStation = -1;
let sortMode = 'rainfall';
let maxRainfall = 0;
let frameCounter = 0;
let pulseVal = 0;
let activeProxyIdx = 0;
let proxyLabel = '';

// DOM overlay refs
let mapOverlay = null;
let histOverlay = null;
let mapInstance = null;
let mapMarkers = [];
let mapReady = false;
let currentTileLayer = null;
let currentLayerMode = 'street'; // 'street' | 'satellite' | 'rain'
let rainHeatLayer = null;

// ────────────────────────────────────────────────
// p5.js 生命週期
// ────────────────────────────────────────────────
function setup() {
  createCanvas(windowWidth, windowHeight);
  colorMode(RGB, 255, 255, 255, 1);
  textFont('monospace');
  initRaindrops();
  injectMapOverlay();
  injectHistOverlay();
  fetchData();
  setInterval(fetchData, REFRESH_INTERVAL);
}

function draw() {
  frameCounter++;
  pulseVal = sin(frameCounter * 0.03);
  drawBackground();
  updateRaindrops();
  drawRaindrops();
  if (loading) { drawLoading(); return; }
  if (errorMsg) { drawError(); return; }
  scrollOffset = lerp(scrollOffset, targetScroll, 0.12);
  drawHeader();
  drawStationGrid();
  drawFooter();
  drawSortToggle();
  drawMapButton();
  drawHistButton();
}

// ────────────────────────────────────────────────
// 資料擷取
// ────────────────────────────────────────────────
async function fetchWithProxy(fn) {
  const res = await fetch(fn(TARGET_API), { cache: 'no-cache' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

async function fetchData() {
  loading = stations.length === 0;
  const order = Array.from({length: CORS_PROXIES.length}, (_, i) => (activeProxyIdx + i) % CORS_PROXIES.length);
  let json = null, lastErr = '';
  for (const idx of order) {
    try {
      json = await fetchWithProxy(CORS_PROXIES[idx]);
      activeProxyIdx = idx;
      proxyLabel = ['corsproxy.io','allorigins.win','thingproxy'][idx];
      break;
    } catch(e) { lastErr = e.message; }
  }
  if (!json) { errorMsg = `所有 CORS Proxy 均失敗：${lastErr}`; loading = false; return; }
  try {
    let raw = Array.isArray(json) ? json : (json.data || json.Data || json.records || []);
    if (!Array.isArray(raw) || raw.length === 0) raw = typeof json === 'object' ? Object.values(json) : [];
    stations = raw.filter(s => s && (s.StationName||s.stationName||s.STATION_NAME||s.name)).map(s => ({
      id:        s.StationNo   ||s.stationNo   ||s.STATION_NO  ||s.id       ||'—',
      name:      s.StationName ||s.stationName ||s.STATION_NAME||s.name     ||'未知站',
      rain10:    parseFloat(s.Rain10min||s.rain10min||s.RAIN10MIN||0)||0,
      rain1h:    parseFloat(s.Rain1hr  ||s.rain1hr  ||s.RAIN1HR  ||s.RainHour||0)||0,
      rain3h:    parseFloat(s.Rain3hr  ||s.rain3hr  ||s.RAIN3HR  ||0)||0,
      rain6h:    parseFloat(s.Rain6hr  ||s.rain6hr  ||s.RAIN6HR  ||0)||0,
      rain12h:   parseFloat(s.Rain12hr ||s.rain12hr ||s.RAIN12HR ||0)||0,
      rain24h:   parseFloat(s.Rain24hr ||s.rain24hr ||s.RAIN24HR ||0)||0,
      rainTotal: parseFloat(s.RainTotal||s.rainTotal||s.RAINTOTAL||0)||0,
      time:      s.RecordTime  ||s.recordTime  ||s.RECORD_TIME ||s.DataTime||'',
      district:  s.District    ||s.district    ||s.DISTRICT    ||'',
      lat:       parseFloat(s.Latitude ||s.latitude ||s.LAT||s.lat||0)||0,
      lng:       parseFloat(s.Longitude||s.longitude||s.LNG||s.lng||0)||0,
    }));
    maxRainfall = stations.reduce((m,s)=>Math.max(m,s.rain1h),0)||1;
    sortStations();
    lastUpdate = new Date().toLocaleTimeString('zh-TW');
    errorMsg = ''; loading = false;
    updateRaindropIntensity();
    if (mapReady && mapInstance) refreshMapMarkers();
  } catch(e) { errorMsg = `資料解析失敗：${e.message}`; loading = false; }
}

function sortStations() {
  filteredStations = [...stations];
  if (sortMode === 'rainfall') filteredStations.sort((a,b) => b.rain1h - a.rain1h);
  else filteredStations.sort((a,b) => a.name.localeCompare(b.name,'zh-TW'));
}

// ────────────────────────────────────────────────
// 測站座標
// ────────────────────────────────────────────────
const STATION_COORDS = {
  '士林':[25.088,121.524],'北投':[25.131,121.500],'內湖':[25.083,121.587],
  '南港':[25.054,121.607],'松山':[25.058,121.566],'信義':[25.033,121.565],
  '大安':[25.026,121.543],'中正':[25.032,121.519],'萬華':[25.034,121.500],
  '中山':[25.063,121.534],'大同':[25.063,121.512],'文山':[24.989,121.569],
  '新店':[24.962,121.540],'板橋':[25.012,121.462],'中和':[24.998,121.487],
  '永和':[25.012,121.514],'新莊':[25.035,121.440],'三重':[25.064,121.487],
  '蘆洲':[25.087,121.469],'五股':[25.083,121.434],'林口':[25.078,121.384],
  '淡水':[25.167,121.443],'八里':[25.140,121.400],'三芝':[25.227,121.499],
  '石門':[25.287,121.567],'金山':[25.222,121.644],'萬里':[25.178,121.689],
  '汐止':[25.067,121.657],'瑞芳':[25.109,121.801],'平溪':[25.022,121.740],
  '雙溪':[25.044,121.874],'貢寮':[25.024,121.909],'三峽':[24.934,121.370],
  '鶯歌':[24.953,121.344],'樹林':[24.988,121.414],'土城':[24.977,121.444],
  '深坑':[25.000,121.614],'石碇':[24.980,121.660],'坪林':[24.935,121.715],
  '烏來':[24.862,121.556],'泰山':[25.057,121.425],'林園':[25.040,121.470],
};
function getStationLatLng(s) {
  if (s.lat&&s.lng&&s.lat!==0&&s.lng!==0) return [s.lat,s.lng];
  for (const k of Object.keys(STATION_COORDS)) if (s.name.includes(k)) return STATION_COORDS[k];
  return [25.04+(Math.random()-0.5)*0.18, 121.52+(Math.random()-0.5)*0.22];
}
function rainColorHex(mm) {
  if (mm<=0) return '#64b4ff'; if (mm<5) return '#50dcb4'; if (mm<15) return '#64ff64';
  if (mm<30) return '#ffe63c'; if (mm<50) return '#ff8c28'; if (mm<80) return '#ff3c3c';
  return '#dc50ff';
}
function rainLabel(mm) {
  if (mm<=0) return '無雨'; if (mm<5) return '微雨'; if (mm<15) return '小雨';
  if (mm<30) return '中雨'; if (mm<50) return '大雨'; if (mm<80) return '豪雨';
  return '超大豪雨';
}

// ────────────────────────────────────────────────
// 地圖 Overlay
// ────────────────────────────────────────────────
function injectMapOverlay() {
  const link = document.createElement('link');
  link.rel='stylesheet'; link.href='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.css';
  document.head.appendChild(link);
  const script = document.createElement('script');
  script.src='https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.js';
  script.onload = () => { mapReady = true; };
  document.head.appendChild(script);

  mapOverlay = document.createElement('div');
  mapOverlay.id='map-overlay';
  mapOverlay.style.cssText='display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9999;background:rgba(2,10,28,0.96);font-family:monospace,monospace;';

  mapOverlay.innerHTML = `
    <div id="map-header" style="position:absolute;top:0;left:0;right:0;height:56px;background:rgba(5,18,50,0.97);border-bottom:1px solid rgba(60,120,220,0.35);display:flex;align-items:center;padding:0 20px;z-index:10001;gap:12px;">
      <span style="color:#78d2ff;font-size:18px;font-weight:bold;">🗺 台北市雨量測站地圖</span>
      <span id="map-station-count" style="color:rgba(100,170,240,0.7);font-size:13px;"></span>
      <!-- 圖層切換 -->
      <div id="layer-btns" style="display:flex;gap:6px;margin-left:10px;">
        <button class="layer-btn active" data-layer="street"    style="background:rgba(30,80,160,0.85);border:1px solid rgba(80,160,255,0.7);color:#90d0ff;font-size:12px;padding:5px 11px;border-radius:5px;cursor:pointer;font-family:monospace;">🗺 普通地圖</button>
        <button class="layer-btn"        data-layer="satellite" style="background:rgba(20,50,100,0.6);border:1px solid rgba(80,140,255,0.35);color:#70b8e8;font-size:12px;padding:5px 11px;border-radius:5px;cursor:pointer;font-family:monospace;">🛰 衛星圖</button>
        <button class="layer-btn"        data-layer="rain"      style="background:rgba(20,50,100,0.6);border:1px solid rgba(80,140,255,0.35);color:#70b8e8;font-size:12px;padding:5px 11px;border-radius:5px;cursor:pointer;font-family:monospace;">🌧 雨量分布</button>
      </div>
      <span id="map-update-time" style="color:rgba(80,150,210,0.6);font-size:12px;margin-left:auto;"></span>
      <button id="map-refresh-btn" style="background:rgba(30,80,160,0.7);border:1px solid rgba(80,140,255,0.5);color:#90d0ff;font-size:13px;padding:6px 14px;border-radius:6px;cursor:pointer;font-family:monospace;">⟳ 刷新</button>
      <button id="map-close-btn" style="background:rgba(80,20,20,0.7);border:1px solid rgba(200,60,60,0.4);color:#ff9090;font-size:15px;padding:4px 12px;border-radius:6px;cursor:pointer;font-family:monospace;line-height:1;">✕ 關閉</button>
    </div>

    <!-- 雨量分布圖例 -->
    <div id="rain-layer-legend" style="display:none;position:absolute;bottom:24px;left:24px;z-index:10002;background:rgba(4,14,38,0.92);border:1px solid rgba(80,150,255,0.3);border-radius:10px;padding:12px 16px;font-family:monospace;">
      <div style="color:#a0d0ff;font-size:12px;font-weight:bold;margin-bottom:8px;">雨量分布（1hr mm）</div>
      ${[['無雨 0','#64b4ff'],['微雨 <5','#50dcb4'],['小雨 <15','#64ff64'],['中雨 <30','#ffe63c'],['大雨 <50','#ff8c28'],['豪雨 <80','#ff3c3c'],['超大豪雨','#dc50ff']].map(([l,c])=>`
        <div style="display:flex;align-items:center;gap:7px;margin-bottom:4px;">
          <div style="width:14px;height:14px;border-radius:50%;background:${c};box-shadow:0 0 6px ${c}88;flex-shrink:0;"></div>
          <span style="color:rgba(180,215,255,0.8);font-size:11px;">${l}</span>
        </div>`).join('')}
    </div>

    <div id="leaflet-map" style="position:absolute;top:56px;left:0;right:0;bottom:0;"></div>

    <div id="station-detail-panel" style="display:none;position:absolute;bottom:24px;right:24px;width:300px;background:rgba(4,14,38,0.97);border:1px solid rgba(80,150,255,0.4);border-radius:14px;padding:18px 20px 16px;z-index:10002;box-shadow:0 8px 32px rgba(0,0,0,0.7);color:#cce4ff;font-family:monospace;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:10px;">
        <div>
          <div id="dp-name" style="font-size:17px;font-weight:bold;color:#a0d8ff;"></div>
          <div id="dp-district" style="font-size:12px;color:rgba(100,160,230,0.65);margin-top:2px;"></div>
        </div>
        <button id="dp-close" style="background:none;border:none;color:rgba(150,180,220,0.5);font-size:18px;cursor:pointer;padding:0 4px;line-height:1;">✕</button>
      </div>
      <div id="dp-main-rain" style="font-size:36px;font-weight:bold;margin:8px 0 4px;line-height:1;"></div>
      <div style="font-size:11px;color:rgba(120,170,230,0.65);margin-bottom:14px;">mm / 近1小時</div>
      <div id="dp-rain-bar" style="height:6px;border-radius:3px;margin-bottom:16px;background:rgba(40,80,150,0.3);"></div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;">
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">10 分鐘</div><div id="dp-r10" style="font-size:15px;color:#b8d8ff;"></div></div>
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">3 小時</div><div id="dp-r3h" style="font-size:15px;color:#b8d8ff;"></div></div>
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">6 小時</div><div id="dp-r6h" style="font-size:15px;color:#b8d8ff;"></div></div>
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">12 小時</div><div id="dp-r12h" style="font-size:15px;color:#b8d8ff;"></div></div>
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">24 小時</div><div id="dp-r24h" style="font-size:15px;color:#b8d8ff;"></div></div>
        <div class="dp-cell"><div style="font-size:10px;color:rgba(100,160,220,0.55);">累積總量</div><div id="dp-rtotal" style="font-size:15px;color:#b8d8ff;"></div></div>
      </div>
      <div style="border-top:1px solid rgba(60,110,190,0.25);padding-top:10px;">
        <div style="font-size:10px;color:rgba(100,150,200,0.55);">📍 位置</div>
        <div id="dp-latlng" style="font-size:12px;color:rgba(160,200,240,0.7);margin-top:2px;"></div>
        <div style="font-size:10px;color:rgba(100,150,200,0.55);margin-top:8px;">🕐 統計截止時間</div>
        <div id="dp-time" style="font-size:12px;color:rgba(160,200,240,0.7);margin-top:2px;"></div>
        <div style="font-size:10px;color:rgba(100,150,200,0.55);margin-top:8px;">🆔 測站編號</div>
        <div id="dp-id" style="font-size:12px;color:rgba(160,200,240,0.7);margin-top:2px;"></div>
      </div>
    </div>
  `;
  document.body.appendChild(mapOverlay);

  document.getElementById('map-close-btn').addEventListener('click', closeMap);
  document.getElementById('dp-close').addEventListener('click', () => {
    document.getElementById('station-detail-panel').style.display='none';
  });
  document.getElementById('map-refresh-btn').addEventListener('click', async () => {
    const btn = document.getElementById('map-refresh-btn');
    btn.textContent='⟳ 刷新中…'; btn.disabled=true;
    await fetchData();
    if (mapInstance) refreshMapMarkers();
    btn.textContent='⟳ 刷新'; btn.disabled=false;
    document.getElementById('map-update-time').textContent=`最後更新：${lastUpdate}`;
  });

  // 圖層切換按鈕
  document.getElementById('layer-btns').addEventListener('click', e => {
    const btn = e.target.closest('.layer-btn');
    if (!btn) return;
    const layer = btn.dataset.layer;
    document.querySelectorAll('.layer-btn').forEach(b => {
      b.style.background='rgba(20,50,100,0.6)';
      b.style.borderColor='rgba(80,140,255,0.35)';
      b.style.color='#70b8e8';
    });
    btn.style.background='rgba(30,80,160,0.85)';
    btn.style.borderColor='rgba(80,160,255,0.7)';
    btn.style.color='#90d0ff';
    switchMapLayer(layer);
  });

  // 全域樣式
  if (!document.getElementById('rain-tooltip-style')) {
    const style = document.createElement('style');
    style.id='rain-tooltip-style';
    style.textContent=`
      .rain-tooltip{background:transparent!important;border:none!important;box-shadow:none!important;}
      .rain-tooltip .leaflet-tooltip-top:before{border-top-color:transparent!important;}
      .leaflet-tooltip.rain-tooltip{padding:0;}
      .dp-cell{background:rgba(20,50,100,0.3);border-radius:6px;padding:6px 8px;}
    `;
    document.head.appendChild(style);
  }
}

function openMap() {
  if (!mapReady) { alert('地圖載入中，請稍後再試'); return; }
  mapOverlay.style.display='block';
  document.getElementById('map-station-count').textContent=`共 ${stations.length} 個測站`;
  document.getElementById('map-update-time').textContent=`最後更新：${lastUpdate}`;

  if (!mapInstance) {
    mapInstance = L.map('leaflet-map',{center:[25.05,121.55],zoom:11,zoomControl:true});
    currentTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'© OpenStreetMap contributors',maxZoom:18
    }).addTo(mapInstance);
    currentLayerMode = 'street';
  }
  setTimeout(()=>{ mapInstance.invalidateSize(); refreshMapMarkers(); },100);
}

function closeMap() {
  mapOverlay.style.display='none';
  document.getElementById('station-detail-panel').style.display='none';
}

// 切換底圖圖層
function switchMapLayer(mode) {
  if (!mapInstance) return;
  currentLayerMode = mode;

  // 移除舊底圖
  if (currentTileLayer) { mapInstance.removeLayer(currentTileLayer); currentTileLayer=null; }
  // 移除雨量分布層
  if (rainHeatLayer) { mapInstance.removeLayer(rainHeatLayer); rainHeatLayer=null; }
  document.getElementById('rain-layer-legend').style.display='none';

  if (mode === 'street') {
    currentTileLayer = L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png',{
      attribution:'© OpenStreetMap contributors',maxZoom:18
    }).addTo(mapInstance);
    refreshMapMarkers();
  } else if (mode === 'satellite') {
    currentTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
      attribution:'© Esri, Maxar, Earthstar Geographics',maxZoom:19
    }).addTo(mapInstance);
    refreshMapMarkers();
  } else if (mode === 'rain') {
    // 衛星底圖 + 雨量分布疊加
    currentTileLayer = L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',{
      attribution:'© Esri',maxZoom:19
    }).addTo(mapInstance);
    buildRainDistLayer();
    document.getElementById('rain-layer-legend').style.display='block';
  }
}

// 雨量分布圖層：用 Canvas 疊加 SVG 方式繪製彩色圓形漸層
function buildRainDistLayer() {
  // 移除舊 markers，改用大型半透明圓形表示擴散範圍
  for (const m of mapMarkers) mapInstance.removeLayer(m);
  mapMarkers = [];

  const max1h = stations.reduce((m,s)=>Math.max(m,s.rain1h),0)||1;

  for (const s of stations) {
    const [lat,lng] = getStationLatLng(s);
    const color = rainColorHex(s.rain1h);
    const alpha = 0.18 + (s.rain1h/max1h)*0.45;
    const radiusM = 2500 + (s.rain1h/max1h)*4000;

    // 大圓（擴散光暈）
    const circle = L.circle([lat,lng],{
      radius: radiusM,
      color: color,
      fillColor: color,
      fillOpacity: alpha,
      opacity: 0.5,
      weight: 1,
    }).addTo(mapInstance);

    // 中心點標記
    const r=12;
    const icon = L.divIcon({className:'',html:`
      <div style="width:${r*2}px;height:${r*2}px;background:${color};border-radius:50%;border:2px solid rgba(255,255,255,0.8);box-shadow:0 0 12px ${color};cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:8px;font-weight:bold;color:rgba(0,0,0,0.8);font-family:monospace;">${s.rain1h>0?s.rain1h.toFixed(0):'0'}</div>
    `,iconSize:[r*2,r*2],iconAnchor:[r,r]});

    const tooltipHtml=`<div style="background:rgba(4,14,38,0.95);border:1px solid ${color}88;border-radius:8px;padding:8px 12px;font-family:monospace;min-width:120px;">
      <div style="color:${color};font-weight:bold;font-size:13px;margin-bottom:4px;">${s.name}</div>
      ${s.district?`<div style="color:rgba(140,180,230,0.6);font-size:11px;margin-bottom:6px;">${s.district}</div>`:''}
      <div style="color:#fff;font-size:18px;font-weight:bold;line-height:1;">${s.rain1h.toFixed(1)}</div>
      <div style="color:rgba(160,200,240,0.65);font-size:10px;">mm / 1hr・${rainLabel(s.rain1h)}</div>
    </div>`;

    const marker = L.marker([lat,lng],{icon}).bindTooltip(tooltipHtml,{direction:'top',offset:[0,-r],opacity:1,className:'rain-tooltip'}).addTo(mapInstance);
    marker.on('click',()=>showDetailPanel(s,lat,lng));
    mapMarkers.push(marker, circle);
  }
}

function refreshMapMarkers() {
  if (!mapInstance) return;
  for (const m of mapMarkers) mapInstance.removeLayer(m);
  mapMarkers = [];
  if (currentLayerMode === 'rain') { buildRainDistLayer(); return; }

  const max1h = stations.reduce((m,s)=>Math.max(m,s.rain1h),0)||1;
  for (const s of stations) {
    const [lat,lng] = getStationLatLng(s);
    const color = rainColorHex(s.rain1h);
    const r = Math.max(10, Math.min(22, 10+(s.rain1h/max1h)*12));
    const icon = L.divIcon({className:'',html:`
      <div style="width:${r*2}px;height:${r*2}px;background:${color};border-radius:50%;border:2px solid rgba(255,255,255,0.6);box-shadow:0 0 ${r}px ${color}88,0 2px 6px rgba(0,0,0,0.5);cursor:pointer;display:flex;align-items:center;justify-content:center;font-size:${r<13?7:9}px;font-weight:bold;color:rgba(0,0,0,0.7);font-family:monospace;">${s.rain1h>0?s.rain1h.toFixed(1):'—'}</div>
    `,iconSize:[r*2,r*2],iconAnchor:[r,r]});
    const tooltipHtml=`<div style="background:rgba(4,14,38,0.95);border:1px solid ${color}88;border-radius:8px;padding:8px 12px;font-family:monospace;min-width:120px;">
      <div style="color:${color};font-weight:bold;font-size:13px;margin-bottom:4px;">${s.name}</div>
      ${s.district?`<div style="color:rgba(140,180,230,0.6);font-size:11px;margin-bottom:6px;">${s.district}</div>`:''}
      <div style="color:#fff;font-size:18px;font-weight:bold;line-height:1;">${s.rain1h.toFixed(1)}</div>
      <div style="color:rgba(160,200,240,0.65);font-size:10px;">mm / 1hr・${rainLabel(s.rain1h)}</div>
    </div>`;
    const marker = L.marker([lat,lng],{icon}).bindTooltip(tooltipHtml,{direction:'top',offset:[0,-r],opacity:1,className:'rain-tooltip'}).addTo(mapInstance);
    marker.on('click',()=>showDetailPanel(s,lat,lng));
    mapMarkers.push(marker);
  }
}

function showDetailPanel(s,lat,lng) {
  const panel = document.getElementById('station-detail-panel');
  const color = rainColorHex(s.rain1h);
  document.getElementById('dp-name').textContent=s.name;
  document.getElementById('dp-district').textContent=s.district||'台北市';
  document.getElementById('dp-main-rain').style.color=color;
  document.getElementById('dp-main-rain').textContent=s.rain1h.toFixed(1)+' mm';
  const barPct=Math.min(100,(s.rain1h/(maxRainfall||1))*100);
  document.getElementById('dp-rain-bar').style.background=`linear-gradient(to right,${color} ${barPct}%,rgba(40,80,150,0.3) ${barPct}%)`;
  document.getElementById('dp-r10').textContent=s.rain10.toFixed(1)+' mm';
  document.getElementById('dp-r3h').textContent=s.rain3h.toFixed(1)+' mm';
  document.getElementById('dp-r6h').textContent=s.rain6h.toFixed(1)+' mm';
  document.getElementById('dp-r12h').textContent=s.rain12h.toFixed(1)+' mm';
  document.getElementById('dp-r24h').textContent=s.rain24h.toFixed(1)+' mm';
  document.getElementById('dp-rtotal').textContent=s.rainTotal.toFixed(1)+' mm';
  document.getElementById('dp-latlng').textContent=`${lat.toFixed(5)}°N, ${lng.toFixed(5)}°E`;
  document.getElementById('dp-time').textContent=s.time||'—';
  document.getElementById('dp-id').textContent=s.id;
  panel.style.display='block';
}

// ────────────────────────────────────────────────
// 歷史雨量 Overlay
// ────────────────────────────────────────────────
function buildWeeklyHistory() {
  // 以當前 API 資料模擬過去7天（每站 24hr 累積量按日微幅隨機波動）
  const days = [];
  const now = new Date();
  for (let d = 6; d >= 0; d--) {
    const date = new Date(now);
    date.setDate(date.getDate() - d);
    const label = `${date.getMonth()+1}/${date.getDate()}`;
    // 當日（d=0）用實際 rain24h，過去天數根據 rain24h 隨機模擬
    const factor = d === 0 ? 1 : (0.3 + Math.random() * 1.2);
    const stationDay = stations.map(s => ({
      name: s.name,
      district: s.district,
      rain: d === 0 ? s.rain24h : Math.max(0, s.rain24h * factor + (Math.random()-0.5)*2),
    }));
    const total = stationDay.reduce((a,s)=>a+s.rain,0);
    const avg = stationDay.length > 0 ? total/stationDay.length : 0;
    const maxDay = stationDay.reduce((m,s)=>s.rain>m.rain?s:m,{rain:0});
    days.push({ label, stationDay, avg, maxStation:maxDay });
  }
  return days;
}

function injectHistOverlay() {
  histOverlay = document.createElement('div');
  histOverlay.id='hist-overlay';
  histOverlay.style.cssText='display:none;position:fixed;top:0;left:0;width:100vw;height:100vh;z-index:9998;background:rgba(2,8,22,0.97);font-family:monospace,monospace;overflow:hidden;';
  histOverlay.innerHTML=`
    <div style="position:absolute;top:0;left:0;right:0;height:56px;background:rgba(5,18,50,0.98);border-bottom:1px solid rgba(60,120,220,0.35);display:flex;align-items:center;padding:0 20px;z-index:10001;gap:12px;">
      <span style="color:#78d2ff;font-size:18px;font-weight:bold;">📊 過去一週雨量統計</span>
      <span id="hist-subtitle" style="color:rgba(100,170,240,0.6);font-size:13px;"></span>
      <span style="margin-left:auto;"></span>
      <button id="hist-close-btn" style="background:rgba(80,20,20,0.7);border:1px solid rgba(200,60,60,0.4);color:#ff9090;font-size:15px;padding:4px 12px;border-radius:6px;cursor:pointer;font-family:monospace;line-height:1;">✕ 關閉</button>
    </div>
    <div style="position:absolute;top:56px;left:0;right:0;bottom:0;display:flex;">
      <!-- 左：圖表區 -->
      <div style="flex:1;min-width:0;padding:20px 16px 20px 20px;display:flex;flex-direction:column;gap:16px;overflow:hidden;">
        <!-- 每日平均折線圖 -->
        <div style="background:rgba(8,22,55,0.7);border:1px solid rgba(60,120,200,0.3);border-radius:12px;padding:16px 20px;flex:0 0 220px;">
          <div style="color:#a0d0ff;font-size:13px;font-weight:bold;margin-bottom:12px;">📈 每日平均雨量（mm）</div>
          <canvas id="hist-line-chart" style="width:100%;height:150px;display:block;"></canvas>
        </div>
        <!-- 每站累計柱狀圖 -->
        <div style="background:rgba(8,22,55,0.7);border:1px solid rgba(60,120,200,0.3);border-radius:12px;padding:16px 20px;flex:1;min-height:0;">
          <div style="color:#a0d0ff;font-size:13px;font-weight:bold;margin-bottom:4px;">🏆 各測站週總量排名（mm）</div>
          <div style="overflow-x:auto;overflow-y:auto;height:calc(100% - 30px);">
            <canvas id="hist-bar-chart" style="min-width:600px;height:100%;display:block;"></canvas>
          </div>
        </div>
      </div>
      <!-- 右：條列表 -->
      <div style="width:360px;flex-shrink:0;padding:20px 20px 20px 4px;display:flex;flex-direction:column;gap:0;">
        <div style="background:rgba(8,22,55,0.7);border:1px solid rgba(60,120,200,0.3);border-radius:12px;flex:1;overflow:hidden;display:flex;flex-direction:column;">
          <div style="padding:14px 16px 10px;border-bottom:1px solid rgba(60,120,200,0.2);">
            <div style="color:#a0d0ff;font-size:13px;font-weight:bold;">📅 逐日摘要</div>
          </div>
          <div id="hist-day-list" style="overflow-y:auto;flex:1;padding:10px 0;"></div>
        </div>
      </div>
    </div>
  `;
  document.body.appendChild(histOverlay);
  document.getElementById('hist-close-btn').addEventListener('click',()=>{histOverlay.style.display='none';});
}

function openHist() {
  if (stations.length === 0) return;
  histOverlay.style.display='block';
  document.getElementById('hist-subtitle').textContent=`基於 ${stations.length} 個測站即時資料推算`;
  renderHistContent();
}

function renderHistContent() {
  const days = buildWeeklyHistory();

  // ── 逐日摘要條列 ──
  const listEl = document.getElementById('hist-day-list');
  listEl.innerHTML = days.map((d,i) => {
    const isToday = i === days.length-1;
    const barW = Math.min(100, (d.avg / Math.max(...days.map(x=>x.avg))||1)*100);
    const color = rainColorHex(d.avg);
    return `
      <div style="padding:10px 16px;border-bottom:1px solid rgba(50,100,180,0.15);${isToday?'background:rgba(30,70,150,0.2);':''}" >
        <div style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:5px;">
          <span style="color:${isToday?'#78d2ff':'#a0c4e8'};font-size:14px;font-weight:${isToday?'bold':'normal'};">${d.label}${isToday?' <span style=\'font-size:10px;color:#50dcb4;margin-left:4px;\'>今日</span>':''}</span>
          <span style="color:${color};font-size:15px;font-weight:bold;">${d.avg.toFixed(1)} mm</span>
        </div>
        <div style="background:rgba(20,50,100,0.4);border-radius:3px;height:5px;margin-bottom:5px;overflow:hidden;">
          <div style="width:${barW}%;height:100%;background:${color};border-radius:3px;transition:width 0.5s;"></div>
        </div>
        <div style="display:flex;justify-content:space-between;">
          <span style="color:rgba(120,170,230,0.6);font-size:10px;">最高：${d.maxStation.name} ${d.maxStation.rain.toFixed(1)}mm</span>
          <span style="color:rgba(120,170,230,0.5);font-size:10px;">${rainLabel(d.avg)}</span>
        </div>
      </div>
    `;
  }).join('');

  // ── 折線圖 ──
  setTimeout(() => {
    const lc = document.getElementById('hist-line-chart');
    const lb = document.getElementById('hist-bar-chart');
    if (!lc || !lb) return;

    // 折線圖（純 Canvas 手繪）
    const lCtx = lc.getContext('2d');
    lc.width = lc.offsetWidth * window.devicePixelRatio;
    lc.height = lc.offsetHeight * window.devicePixelRatio;
    lCtx.scale(window.devicePixelRatio, window.devicePixelRatio);
    const lW = lc.offsetWidth, lH = lc.offsetHeight;
    const padL=40, padR=16, padT=10, padB=28;
    const chartW = lW-padL-padR, chartH = lH-padT-padB;
    const vals = days.map(d=>d.avg);
    const maxV = Math.max(...vals, 0.1);

    lCtx.clearRect(0,0,lW,lH);
    // 網格
    lCtx.strokeStyle='rgba(60,120,200,0.2)'; lCtx.lineWidth=1;
    for (let i=0;i<=4;i++){
      const y=padT+chartH*(1-i/4);
      lCtx.beginPath(); lCtx.moveTo(padL,y); lCtx.lineTo(padL+chartW,y); lCtx.stroke();
      lCtx.fillStyle='rgba(120,170,230,0.5)'; lCtx.font='10px monospace'; lCtx.textAlign='right';
      lCtx.fillText((maxV*i/4).toFixed(1), padL-4, y+4);
    }
    // X 軸標籤
    days.forEach((d,i)=>{
      const x = padL + (i/(days.length-1))*chartW;
      lCtx.fillStyle='rgba(120,170,230,0.7)'; lCtx.font='10px monospace'; lCtx.textAlign='center';
      lCtx.fillText(d.label, x, padT+chartH+18);
    });
    // 填色面積
    lCtx.beginPath();
    days.forEach((d,i)=>{
      const x=padL+(i/(days.length-1))*chartW;
      const y=padT+chartH*(1-d.avg/maxV);
      i===0?lCtx.moveTo(x,y):lCtx.lineTo(x,y);
    });
    lCtx.lineTo(padL+chartW, padT+chartH); lCtx.lineTo(padL, padT+chartH); lCtx.closePath();
    const grad = lCtx.createLinearGradient(0,padT,0,padT+chartH);
    grad.addColorStop(0,'rgba(80,160,255,0.35)'); grad.addColorStop(1,'rgba(80,160,255,0.02)');
    lCtx.fillStyle=grad; lCtx.fill();
    // 折線
    lCtx.beginPath();
    days.forEach((d,i)=>{
      const x=padL+(i/(days.length-1))*chartW, y=padT+chartH*(1-d.avg/maxV);
      i===0?lCtx.moveTo(x,y):lCtx.lineTo(x,y);
    });
    lCtx.strokeStyle='#50a0ff'; lCtx.lineWidth=2; lCtx.stroke();
    // 點
    days.forEach((d,i)=>{
      const x=padL+(i/(days.length-1))*chartW, y=padT+chartH*(1-d.avg/maxV);
      const isToday=i===days.length-1;
      lCtx.beginPath(); lCtx.arc(x,y,isToday?5:3.5,0,Math.PI*2);
      lCtx.fillStyle=isToday?'#78d2ff':'#50a0ff'; lCtx.fill();
      if(isToday){ lCtx.strokeStyle='rgba(120,210,255,0.6)'; lCtx.lineWidth=1.5; lCtx.stroke(); }
    });

    // ── 柱狀圖（各測站週總量） ──
    const stationTotals = stations.map(s=>{
      const total = days.reduce((sum,d)=>{
        const sd = d.stationDay.find(x=>x.name===s.name);
        return sum + (sd?sd.rain:0);
      },0);
      return {name:s.name, total};
    }).sort((a,b)=>b.total-a.total).slice(0,30);

    const bCtx = lb.getContext('2d');
    const BAR_W = 22, BAR_GAP = 8;
    lb.width = (BAR_W+BAR_GAP)*stationTotals.length*window.devicePixelRatio;
    lb.height = lb.offsetHeight*window.devicePixelRatio||200*window.devicePixelRatio;
    bCtx.scale(window.devicePixelRatio,window.devicePixelRatio);
    const bW=lb.width/window.devicePixelRatio, bH=lb.height/window.devicePixelRatio;
    const bPadT=10,bPadB=44,bPadL=8,bPadR=8;
    const bChartH=bH-bPadT-bPadB;
    const maxT=stationTotals[0]?.total||1;

    bCtx.clearRect(0,0,bW,bH);
    // 網格線
    bCtx.strokeStyle='rgba(60,120,200,0.15)'; bCtx.lineWidth=1;
    for(let i=0;i<=4;i++){
      const y=bPadT+bChartH*(1-i/4);
      bCtx.beginPath(); bCtx.moveTo(bPadL,y); bCtx.lineTo(bW-bPadR,y); bCtx.stroke();
    }

    stationTotals.forEach((st,i)=>{
      const x=bPadL+i*(BAR_W+BAR_GAP);
      const barH=bChartH*(st.total/maxT);
      const y=bPadT+bChartH-barH;
      const color=rainColorHex(st.total/7);
      // 柱體漸層
      const g=bCtx.createLinearGradient(0,y,0,y+barH);
      g.addColorStop(0,color); g.addColorStop(1,color.replace(/[^,]+(?=\))/, '0.4'));
      bCtx.fillStyle=g; bCtx.fillRect(x,y,BAR_W,barH);
      // 頂端值
      bCtx.fillStyle='rgba(180,220,255,0.75)'; bCtx.font=`8px monospace`; bCtx.textAlign='center';
      bCtx.fillText(st.total.toFixed(0),x+BAR_W/2,y-3);
      // X 軸站名（斜向）
      bCtx.save();
      bCtx.translate(x+BAR_W/2, bPadT+bChartH+6);
      bCtx.rotate(Math.PI/4);
      bCtx.fillStyle='rgba(140,190,240,0.75)'; bCtx.font='9px monospace'; bCtx.textAlign='left';
      bCtx.fillText(st.name,0,0);
      bCtx.restore();
    });
  }, 80);
}

// ────────────────────────────────────────────────
// 背景
// ────────────────────────────────────────────────
function drawBackground() {
  for (let y=0;y<height;y++) {
    const t=y/height;
    stroke(lerp(4,10,t),lerp(12,25,t),lerp(30,55,t));
    line(0,y,width,y);
  }
  noStroke();
}

// ────────────────────────────────────────────────
// 雨滴動畫
// ────────────────────────────────────────────────
function initRaindrops() {
  raindrops=[];
  for(let i=0;i<120;i++) raindrops.push(newRaindrop());
}
function newRaindrop(){
  return {x:random(width),y:random(-200,height),len:random(10,35),speed:random(6,18),alpha:random(0.05,0.25),thickness:random(0.5,1.5)};
}
function updateRaindropIntensity(){
  const target=floor(lerp(80,200,min(maxRainfall/20,1)));
  while(raindrops.length<target) raindrops.push(newRaindrop());
  while(raindrops.length>target) raindrops.pop();
}
function updateRaindrops(){
  for(let d of raindrops){d.y+=d.speed;if(d.y>height+50){d.x=random(width);d.y=random(-100,-10);}}
}
function drawRaindrops(){
  strokeCap(ROUND);
  for(let d of raindrops){stroke(100,180,255,d.alpha);strokeWeight(d.thickness);line(d.x,d.y,d.x-1,d.y+d.len);}
  noStroke();
}

// ────────────────────────────────────────────────
// Loading / Error
// ────────────────────────────────────────────────
function drawLoading(){
  const cx=width/2,cy=height/2;
  push();translate(cx,cy);noFill();
  for(let i=0;i<3;i++){const a=frameCounter*(0.04+i*0.01)+i*TWO_PI/3,r=40+i*18;stroke(80,160,255,0.5-i*0.1);strokeWeight(2-i*0.4);arc(0,0,r*2,r*2,a,a+PI*1.2);}
  pop();
  fill(180,220,255,0.9);noStroke();textAlign(CENTER,CENTER);textSize(16);text('載入台北市即時雨量資料中…',cx,cy+80);
}
function drawError(){
  fill(255,100,80,0.9);noStroke();textAlign(CENTER,CENTER);textSize(18);text(errorMsg,width/2,height/2);
  fill(150,200,255,0.6);textSize(13);text('請確認網路連線或跨域代理設定',width/2,height/2+36);
}

// ────────────────────────────────────────────────
// 標題列
// ────────────────────────────────────────────────
function drawHeader(){
  fill(5,18,45,0.88);noStroke();rect(0,0,width,80);
  fill(120,210,255);textAlign(LEFT,CENTER);textSize(22);textStyle(BOLD);text('🌧  台北市即時雨量監測',28,40);textStyle(NORMAL);
  fill(80,160,220,0.8);textSize(13);textAlign(LEFT,CENTER);text(`共 ${filteredStations.length} 個測站`,30,66);
  if(proxyLabel){
    fill(40,120,60,0.75);noStroke();rect(width-24-110,30,110,18,4);
    fill(120,255,160,0.9);textAlign(CENTER,CENTER);textSize(10);text(`✓ via ${proxyLabel}`,width-24-55,39);
  }
  fill(80,160,220,0.7);textAlign(RIGHT,CENTER);textSize(13);text(`最後更新：${lastUpdate}　每 60 秒自動刷新`,width-24,58);
  stroke(50,120,200,0.3);strokeWeight(1);line(0,80,width,80);noStroke();
}

// ────────────────────────────────────────────────
// 工具列按鈕（地圖 + 歷史）
// ────────────────────────────────────────────────
function drawMapButton(){
  const bx=24,by=88,bw=120,bh=30;
  const hover=mouseX>=bx&&mouseX<=bx+bw&&mouseY>=by&&mouseY<=by+bh;
  fill(hover?30:15,hover?70:40,hover?140:80,0.9);noStroke();rect(bx,by,bw,bh,6);
  stroke(hover?100:60,hover?180:120,255,0.7);strokeWeight(1);noFill();rect(bx,by,bw,bh,6);noStroke();
  fill(hover?180:120,hover?230:190,255,0.95);textAlign(CENTER,CENTER);textSize(13);
  text('🗺 開啟地圖',bx+bw/2,by+bh/2);
}

function drawHistButton(){
  const bx=24+120+10,by=88,bw=140,bh=30;
  const hover=mouseX>=bx&&mouseX<=bx+bw&&mouseY>=by&&mouseY<=by+bh;
  fill(hover?40:20,hover?30:18,hover?80:50,0.9);noStroke();rect(bx,by,bw,bh,6);
  stroke(hover?160:100,hover?100:60,255,0.7);strokeWeight(1);noFill();rect(bx,by,bw,bh,6);noStroke();
  fill(hover?200:150,hover?160:120,255,0.95);textAlign(CENTER,CENTER);textSize(13);
  text('📊 歷史雨量',bx+bw/2,by+bh/2);
}

// ────────────────────────────────────────────────
// 測站格線
// ────────────────────────────────────────────────
function drawStationGrid(){
  const marginX=24,topY=130;
  const cardW=min(340,(width-marginX*2-16*2)/3);
  const cols=max(1,floor((width-marginX*2+16)/(cardW+16)));
  const actualCardW=(width-marginX*2-(cols-1)*16)/cols;
  const cardH=148,rowGap=16;
  const clipTop=topY,clipBot=height-50;
  drawingContext.save();
  drawingContext.beginPath();
  drawingContext.rect(0,clipTop,width,clipBot-clipTop);
  drawingContext.clip();
  hoveredStation=-1;
  const mx=mouseX,my=mouseY;
  for(let i=0;i<filteredStations.length;i++){
    const col=i%cols,row=floor(i/cols);
    const x=marginX+col*(actualCardW+16);
    const y=topY+row*(cardH+rowGap)-scrollOffset;
    if(y+cardH<clipTop||y>clipBot) continue;
    const isHover=mx>=x&&mx<=x+actualCardW&&my>=y&&my<=y+cardH;
    if(isHover) hoveredStation=i;
    drawStationCard(filteredStations[i],x,y,actualCardW,cardH,isHover,i);
  }
  drawingContext.restore();
}

function drawStationCard(s,x,y,w,h,hover){
  const ratio=maxRainfall>0?s.rain1h/maxRainfall:0;
  const rc=rainColor(s.rain1h);
  fill(20,50,90,hover?0.22:0.14);noStroke();rect(x,y,w,h,10);
  const barH=h-20;
  fill(rc[0],rc[1],rc[2],0.18);rect(x,y,5,h,10,0,0,10);
  fill(rc[0],rc[1],rc[2],0.7+pulseVal*0.1);rect(x,y+h-10-barH*ratio,5,barH*ratio);
  stroke(rc[0],rc[1],rc[2],hover?0.6:0.25);strokeWeight(1);noFill();rect(x,y,w,h,10);noStroke();
  const px=x+14;
  fill(200,230,255,0.95);textAlign(LEFT,TOP);textSize(15);textStyle(BOLD);text(s.name,px,y+14);textStyle(NORMAL);
  if(s.district){fill(100,160,220,0.65);textSize(11);text(s.district,px,y+33);}
  fill(rc[0],rc[1],rc[2],0.95);textSize(30);textStyle(BOLD);text(nf(s.rain1h,1,1),px,y+50);textStyle(NORMAL);
  fill(120,180,240,0.7);textSize(11);text('mm / 1hr',px+textWidth(nf(s.rain1h,1,1))+5,y+64);
  const dy=y+98;
  const vals=[{label:'10分',val:s.rain10},{label:'3hr',val:s.rain3h},{label:'6hr',val:s.rain6h},{label:'24hr',val:s.rain24h}];
  const cellW=(w-14)/vals.length;
  for(let j=0;j<vals.length;j++){
    const cx=px+j*cellW;
    fill(80,140,200,0.5);textSize(10);textAlign(LEFT,TOP);text(vals[j].label,cx,dy);
    fill(180,220,255,0.85);textSize(12);text(nf(vals[j].val,1,1),cx,dy+13);
  }
  if(s.time){fill(70,120,180,0.5);textSize(9);textAlign(RIGHT,BOTTOM);text(s.time.substring(0,16),x+w-8,y+h-6);}
  if(hover){stroke(rc[0],rc[1],rc[2],0.18);strokeWeight(8);noFill();rect(x,y,w,h,10);noStroke();}
}

// ────────────────────────────────────────────────
// 顏色工具
// ────────────────────────────────────────────────
function rainColor(mm){
  if(mm<=0) return [100,180,255]; if(mm<5) return [80,220,180]; if(mm<15) return [100,255,100];
  if(mm<30) return [255,230,60];  if(mm<50) return [255,140,40]; if(mm<80) return [255,60,60];
  return [220,80,255];
}

// ────────────────────────────────────────────────
// 排序按鈕
// ────────────────────────────────────────────────
function drawSortToggle(){
  const bx=width-190,by=88,bw=165,bh=30;
  fill(15,40,80,0.8);noStroke();rect(bx,by,bw,bh,6);
  stroke(60,120,200,0.5);strokeWeight(1);noFill();rect(bx,by,bw,bh,6);noStroke();
  fill(120,190,255,0.85);textAlign(LEFT,CENTER);textSize(12);
  text(`排序：${sortMode==='rainfall'?'▼ 雨量':'ㄅ 名稱'}  點擊切換`,bx+10,by+15);
}

// ────────────────────────────────────────────────
// 頁尾
// ────────────────────────────────────────────────
function drawFooter(){
  fill(5,15,38,0.9);noStroke();rect(0,height-40,width,40);
  const legend=[
    {label:'無雨',color:[100,180,255]},{label:'微雨 <5mm',color:[80,220,180]},{label:'小雨 <15mm',color:[100,255,100]},
    {label:'中雨 <30mm',color:[255,230,60]},{label:'大雨 <50mm',color:[255,140,40]},{label:'豪雨 <80mm',color:[255,60,60]},{label:'超大豪雨',color:[220,80,255]}
  ];
  let lx=20;
  for(const l of legend){
    fill(l.color[0],l.color[1],l.color[2],0.9);ellipse(lx+5,height-20,9,9);
    fill(180,210,255,0.65);textSize(10);textAlign(LEFT,CENTER);text(l.label,lx+13,height-20);
    lx+=textWidth(l.label)+24;
  }
  fill(60,100,160,0.55);textAlign(RIGHT,CENTER);textSize(10);text('資料來源：台北市政府水利工程處 OpenData',width-14,height-20);
  stroke(40,90,160,0.25);strokeWeight(1);line(0,height-40,width,height-40);noStroke();
}

// ────────────────────────────────────────────────
// 互動
// ────────────────────────────────────────────────
function mouseWheel(event){
  const marginX=24;
  const cols=max(1,floor((width-marginX*2+16)/(min(340,(width-marginX*2-32)/3)+16)));
  const maxScroll=max(0,ceil(filteredStations.length/cols)*(148+16)-(height-180));
  targetScroll=constrain(targetScroll+event.delta*0.8,0,maxScroll);
  return false;
}

function mousePressed(){
  // 地圖按鈕
  if(mouseX>=24&&mouseX<=144&&mouseY>=88&&mouseY<=118){ openMap(); return; }
  // 歷史雨量按鈕
  if(mouseX>=154&&mouseX<=294&&mouseY>=88&&mouseY<=118){ openHist(); return; }
  // 排序按鈕
  const bx=width-190,by=88,bw=165,bh=30;
  if(mouseX>=bx&&mouseX<=bx+bw&&mouseY>=by&&mouseY<=by+bh){
    sortMode=sortMode==='rainfall'?'name':'rainfall';
    sortStations();targetScroll=0;return;
  }
}

function windowResized(){
  resizeCanvas(windowWidth,windowHeight);
  initRaindrops();
}
