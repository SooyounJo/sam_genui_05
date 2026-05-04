// ============================================================================
//  figma-refs/icon_library.js — inline SVG icon bank
//  ---------------------------------------------------------------------------
//  One UI 8.5 icons expressed as inline SVG strings so the generator can paint
//  them at runtime without depending on Figma MCP asset URLs (which expire
//  after 7 days). Each icon here mirrors the Figma source (catalog entry in
//  icon_assets.json) and uses `currentColor` so consumers can tint via CSS.
//
//  Icons are grouped by category matching icon_assets.json:
//    statusBar.wifi[strength]        → WiFi signal (0-3)
//    statusBar.cellular[strength]    → Cellular signal (0-4)
//    statusBar.battery[state]        → Battery state icons
//    category[name]                  → Settings category icons (36dp)
//    fileType[name]                  → File manager icons (24dp)
//    sim[name]                       → SIM / contact icons (24dp)
//
//  Usage:
//    const svg = IconLibrary.statusBar.wifi[3];        // returns SVG string
//    const svg = IconLibrary.statusBar.battery.default;
//    const bar = IconLibrary.renderStatusBar({ time: '9:41', theme: 'dark',
//                                              wifi: 3, cellular: 4, battery: 85 });
// ============================================================================

'use strict';

(function (root) {

  // ==========================================================================
  //  WiFi — 4 strength levels (filled waves shrink as strength drops)
  // ==========================================================================
  var wifi = {
    3: '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 14.5c.69 0 1.25-.56 1.25-1.25S9.69 12 9 12s-1.25.56-1.25 1.25S8.31 14.5 9 14.5z" fill="currentColor"/><path d="M4.5 10.5C5.75 9.25 7.3 8.5 9 8.5s3.25.75 4.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 8C3.75 6.25 6.25 5 9 5s5.25 1.25 7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
    2: '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 14.5c.69 0 1.25-.56 1.25-1.25S9.69 12 9 12s-1.25.56-1.25 1.25S8.31 14.5 9 14.5z" fill="currentColor"/><path d="M4.5 10.5C5.75 9.25 7.3 8.5 9 8.5s3.25.75 4.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/><path d="M2 8C3.75 6.25 6.25 5 9 5s5.25 1.25 7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/></svg>',
    1: '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 14.5c.69 0 1.25-.56 1.25-1.25S9.69 12 9 12s-1.25.56-1.25 1.25S8.31 14.5 9 14.5z" fill="currentColor"/><path d="M4.5 10.5C5.75 9.25 7.3 8.5 9 8.5s3.25.75 4.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/><path d="M2 8C3.75 6.25 6.25 5 9 5s5.25 1.25 7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/></svg>',
    0: '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M9 14.5c.69 0 1.25-.56 1.25-1.25S9.69 12 9 12s-1.25.56-1.25 1.25S8.31 14.5 9 14.5z" fill="currentColor" opacity="0.4"/><path d="M4.5 10.5C5.75 9.25 7.3 8.5 9 8.5s3.25.75 4.5 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/><path d="M2 8C3.75 6.25 6.25 5 9 5s5.25 1.25 7 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" opacity="0.3"/></svg>'
  };

  // ==========================================================================
  //  Cellular — 5 ascending bars (0 = no bars, 4 = all filled)
  // ==========================================================================
  function cellularSVG(strength) {
    // bars from short to tall, highlighted up to `strength`
    var heights = [3, 5.5, 8, 10.5, 13];
    var bars = '';
    for (var i = 0; i < 5; i++) {
      var x = 2 + i * 2.7;
      var h = heights[i];
      var y = 15 - h;
      var opacity = (i < strength) ? '1' : '0.3';
      bars += '<rect x="' + x + '" y="' + y + '" width="2" height="' + h + '" rx="0.5" fill="currentColor" opacity="' + opacity + '"/>';
    }
    return '<svg viewBox="0 0 18 18" fill="none" xmlns="http://www.w3.org/2000/svg">' + bars + '</svg>';
  }
  var cellular = {
    0: cellularSVG(0),
    1: cellularSVG(1),
    2: cellularSVG(2),
    3: cellularSVG(3),
    4: cellularSVG(4)
  };

  // ==========================================================================
  //  Battery — pill-shape with fill + cap, various states
  // ==========================================================================
  function batteryBase(fillPercent, extras) {
    var fillW = Math.max(0, Math.min(18, (fillPercent / 100) * 18));
    var fillColor = fillPercent <= 15 ? '#F04438' :
                    fillPercent <= 30 ? '#F79009' :
                    'currentColor';
    return '<svg viewBox="0 0 27 13" fill="none" xmlns="http://www.w3.org/2000/svg">' +
           '<rect x="0.5" y="0.5" width="23" height="12" rx="2.5" stroke="currentColor" stroke-width="1" fill="none" opacity="0.4"/>' +
           '<rect x="2" y="2" width="' + fillW + '" height="9" rx="1.2" fill="' + fillColor + '"/>' +
           '<rect x="24.5" y="3.5" width="2" height="6" rx="1" fill="currentColor" opacity="0.4"/>' +
           (extras || '') +
           '</svg>';
  }
  var battery = {
    'fully-charged': batteryBase(100),
    'default':       batteryBase(85),
    'charging':      batteryBase(60,
      '<path d="M11 3L9 7.5H11L9 11L13 6.5H11L13 3Z" fill="#FFFFFF" stroke="currentColor" stroke-width="0.4" stroke-linejoin="round"/>'),
    'low':           batteryBase(20),
    'very-low':      batteryBase(10),
    'battery-saver': batteryBase(50,
      '<path d="M8 4L10 7H8.5L10 10" stroke="#FFFFFF" stroke-width="1" stroke-linecap="round" stroke-linejoin="round" fill="none"/>'),
    'battery-protect': batteryBase(75,
      '<path d="M11 3.5L8.5 5V7.5C8.5 9 9.5 10 11 10.5C12.5 10 13.5 9 13.5 7.5V5L11 3.5Z" fill="none" stroke="#FFFFFF" stroke-width="0.8" stroke-linejoin="round"/>')
  };

  // ==========================================================================
  //  UI — shared One UI icons (AI sparkle, etc.)
  // ==========================================================================
  // One UI "ai-colour" star (Figma node 449:385) — 4-point star with pinched
  // waist + small accent sparkle. Uses a Galaxy AI gradient; each call
  // generates a unique gradient ID to avoid collisions when multiple copies
  // are rendered on the same page.
  var _aiStarSeq = 0;
  function aiStar(opts) {
    var o = opts || {};
    var size = o.size || 18;
    var monochrome = !!o.monochrome;
    var gid = 'aiStarGrad_' + (++_aiStarSeq);
    var fill = monochrome ? 'currentColor' : 'url(#' + gid + ')';
    var gradient = monochrome ? '' :
      '<defs><linearGradient id="' + gid + '" x1="2" y1="2" x2="22" y2="22" gradientUnits="userSpaceOnUse">' +
        '<stop offset="0%" stop-color="#3E91FF"/>' +
        '<stop offset="50%" stop-color="#64E9E3"/>' +
        '<stop offset="100%" stop-color="#9FFAC7"/>' +
      '</linearGradient></defs>';
    // Main 4-point star (pinched-waist diamond)
    var mainStar = '<path d="M12 2C12 6 13 9 16 11C13 13 12 16 12 20C12 16 11 13 8 11C11 9 12 6 12 2Z" fill="' + fill + '"/>';
    // Accent sparkle (upper-right, smaller)
    var accent   = '<path d="M19 14C19 15.5 19.5 17 21 17.5C19.5 18 19 19.5 19 21C19 19.5 18.5 18 17 17.5C18.5 17 19 15.5 19 14Z" fill="' + fill + '" opacity="0.85"/>';
    return '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" data-name="ai-star">' +
             gradient + mainStar + accent +
           '</svg>';
  }

  // ==========================================================================
  //  Render helpers
  // ==========================================================================

  /**
   * Build a full Samsung status bar row (time + right-aligned icons).
   * @param {Object} opts
   * @param {string} [opts.time='9:41']
   * @param {'dark'|'light'} [opts.theme='dark']
   * @param {number} [opts.wifi=3]       0-3
   * @param {number} [opts.cellular=4]   0-4
   * @param {number} [opts.battery=85]   0-100 → resolves to icon state
   * @param {string} [opts.batteryState] override battery icon key directly
   * @param {number} [opts.height=30]    row height in px
   * @returns {string} HTML string ready to inject
   */
  function renderStatusBar(opts) {
    var o = opts || {};
    var theme = o.theme || 'dark';
    var color = (theme === 'dark') ? 'rgba(255,255,255,0.92)' : '#1a1a1a';
    var time  = o.time || '9:41';
    var h     = o.height || 30;

    var wifiStrength = (o.wifi != null) ? o.wifi : 3;
    var cellStrength = (o.cellular != null) ? o.cellular : 4;
    var battPct      = (o.battery != null) ? o.battery : 85;
    var battState    = o.batteryState ||
                       (battPct <= 15 ? 'very-low' :
                        battPct <= 30 ? 'low' :
                        battPct >= 98 ? 'fully-charged' : 'default');

    var wifiSvg  = '<span class="sb-icon sb-wifi" style="display:inline-flex;width:14px;height:14px;">'     + (wifi[wifiStrength]     || wifi[3])      + '</span>';
    var cellSvg  = '<span class="sb-icon sb-cell" style="display:inline-flex;width:14px;height:14px;">'     + (cellular[cellStrength] || cellular[4])  + '</span>';
    var battSvg  = '<span class="sb-icon sb-bat"  style="display:inline-flex;width:22px;height:11px;align-items:center;">' + (battery[battState]     || battery['default']) + '</span>';

    return '<div class="status-bar" style="display:flex;justify-content:space-between;align-items:center;padding:4px 18px;height:' + h + 'px;font-size:12px;font-weight:600;color:' + color + ';font-family:Inter,system-ui,sans-serif;letter-spacing:0.2px;">' +
             '<span class="sb-time">' + time + '</span>' +
             '<span class="sb-right" style="display:inline-flex;align-items:center;gap:4px;">' +
               cellSvg + wifiSvg + battSvg +
             '</span>' +
           '</div>';
  }

  /**
   * Low-level lookup: returns an SVG string for a given namespaced key.
   *   getIcon('status-bar.wifi.3')
   *   getIcon('status-bar.battery.charging')
   *   getIcon('status-bar.cellular.4')
   * Returns null if unknown (caller should fall back gracefully).
   */
  function getIcon(key, opts) {
    if (!key) return null;
    var parts = String(key).split('.');
    var ns = parts[0], group = parts[1], name = parts.slice(2).join('.') || parts[2];
    if (ns === 'status-bar') {
      if (group === 'wifi')     return wifi[parseInt(name, 10)] || null;
      if (group === 'cellular') return cellular[parseInt(name, 10)] || null;
      if (group === 'battery')  return battery[name] || null;
    }
    if (ns === 'ui') {
      if (group === 'ai-star')  return aiStar(opts);
    }
    return null;
  }

  // ==========================================================================
  //  Export (Node + Browser)
  // ==========================================================================
  var IconLibrary = {
    statusBar: { wifi: wifi, cellular: cellular, battery: battery },
    ui: { aiStar: aiStar },
    renderStatusBar: renderStatusBar,
    aiStar: aiStar,
    getIcon: getIcon
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = IconLibrary;
  }
  if (typeof root !== 'undefined') {
    root.IconLibrary = IconLibrary;
  }

})(typeof window !== 'undefined' ? window : this);
