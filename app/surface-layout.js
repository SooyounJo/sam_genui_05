// ============================================================================
// app/surface-layout.js
// One UI surface grammar based layout system
// Surface-first, zone-first, slot-based renderer
// ============================================================================

window.SURFACE_TYPES = {
  LOCKSCREEN: 'lockscreen',
  FIRST_DEPTH_LIST: 'first-depth-list',
  SECOND_DEPTH_DETAIL: 'second-depth-detail',
  TAB_ROOT: 'tab-root',
  DIALOG_BOTTOM: 'dialog-bottom',
  DIALOG_CENTER: 'dialog-center',
  QUICK_SETTINGS: 'quick-settings',
  NOTIFICATION_SHADE: 'notification-shade',
  SELECTION_MODE: 'selection-mode'
};

window.currentSurfaceType = window.SURFACE_TYPES.FIRST_DEPTH_LIST;

/** Themes set `--oneui-chroma: mono` (e.g. Mono · Grayscale) so skies/icons stay neutral — no chroma accents in markup. */
function _isMonoChromaRoot() {
  try {
    if (typeof document === 'undefined' || !document.documentElement) return false;
    if (document.documentElement.classList.contains('is-mono-chroma')) return true;
    var v = (getComputedStyle(document.documentElement).getPropertyValue('--oneui-chroma') || '').trim().toLowerCase();
    return v === 'mono' || v === 'grayscale' || v === 'greyscale';
  } catch (e) {
    return false;
  }
}

function _themeSurfaceStyleRoot() {
  try {
    if (typeof document === 'undefined' || !document.documentElement) return 'base';
    var v = (getComputedStyle(document.documentElement).getPropertyValue('--oneui-theme-style') || '').trim().toLowerCase();
    return v || 'base';
  } catch (e) {
    return 'base';
  }
}

window.setSurfaceType = function setSurfaceType(type, el) {
  window.currentSurfaceType = type;

  document.querySelectorAll('.layout-preset').forEach(p => p.classList.remove('active'));
  if (el) el.classList.add('active');
};

window.createOneUILayout = function createOneUILayout(viewport, surfaceType) {
  const width = viewport.width || 451;
  const height = viewport.height || 978;

  // Safe-area insets — must clear the device frame's rounded bezel
  // (border-radius:44px on .canvas-frame). Previous safe.bottom=16 was
  // smaller than the bezel radius, so bottom-edge content (shortcut
  // circles, charging pill) ended up partially clipped inside the
  // rounded corner — visible at 100% browser zoom in the user's
  // screenshot. Bumped to 36 (clears the 44px arc and leaves a small
  // visual gap so content doesn't kiss the bezel). Top stays smaller
  // because the status-bar zone already adds visual margin.
  const safe = {
    top: 16,
    right: 28,
    bottom: 36,
    left: 28
  };

  const topSystemH = 28;
  const appBarExpandedH = Math.round(height * 0.22);
  const appBarCollapsedH = 56;
  const interactionStartY = Math.round(height * 0.58);
  // bottomNavH bumped from 72 → 80 so the shortcut circles + now-bar
  // pill have enough vertical room AND are positioned higher within
  // the safe area (no longer touching the bezel arc).
  const bottomNavH = 80;
  const bottomBarH = 64;

  return {
    viewport: { width, height },
    safe,
    metrics: {
      topSystemH,
      appBarExpandedH,
      appBarCollapsedH,
      interactionStartY,
      bottomNavH,
      bottomBarH,
      gap: 12,
      focusBlockRadius: 28
    },
    zones: {
      full: {
        x: 0, y: 0, w: width, h: height
      },
      topSystem: {
        x: safe.left,
        y: safe.top,
        w: width - safe.left - safe.right,
        h: topSystemH
      },
      viewing: {
        x: safe.left,
        y: safe.top + topSystemH + 8,
        w: width - safe.left - safe.right,
        h: interactionStartY - (safe.top + topSystemH + 8) - 12
      },
      interaction: {
        x: safe.left,
        y: interactionStartY,
        w: width - safe.left - safe.right,
        h: height - interactionStartY - safe.bottom - bottomNavH
      },
      bottomNav: {
        x: safe.left,
        y: height - safe.bottom - bottomNavH,
        w: width - safe.left - safe.right,
        h: bottomNavH
      },
      bottomBar: {
        x: safe.left,
        y: height - safe.bottom - bottomBarH,
        w: width - safe.left - safe.right,
        h: bottomBarH
      }
    },
    surfaceType
  };
};

window.composeSurfacePlan = function composeSurfacePlan(surfaceType, layout) {
  const T = window.SURFACE_TYPES;

  switch (surfaceType) {
    case T.LOCKSCREEN:
      // Samsung Lock identity chrome. These slot names match the
      // canonical Scene/Lock template (see app/rules-renderer.js
      // ROLE_RENDERERS lookup) so the DOM node id + data-role emitted
      // by the agent path is IDENTICAL to what the canned "Screens >
      // Lock" scene produces. That way the Layers inspector, CSS
      // selectors, and downstream tooling see one naming convention
      // instead of two.
      //   • status-bar    = signal / battery / carrier row
      //   • lockIndicator = padlock icon at top center (Figma y=48)
      //   • weatherDate   = "68° · Partly cloudy · Thu Apr 24" thin line
      //   • clock         = huge center clock (renderer uses current time)
      //   • shortcutLeft  = phone shortcut circle (bottom-left)
      //   • shortcutRight = camera shortcut circle (bottom-right)
      //   • gestureBar    = bottom home-gesture indicator bar
      return {
        surfaceType,
        components: [
          { id: 'status-bar',    role: 'status-bar',    zone: 'topSystem' },
          { id: 'lockIndicator', role: 'lockIndicator', zone: 'topSystem' },
          { id: 'weatherDate',   role: 'weatherDate',   zone: 'viewing' },
          { id: 'clock',         role: 'clock',         zone: 'viewing' },
          { id: 'shortcutLeft',  role: 'shortcutLeft',  zone: 'bottomNav', variant: { icon: 'phone' } },
          { id: 'shortcutRight', role: 'shortcutRight', zone: 'bottomNav', variant: { icon: 'camera' } },
          { id: 'gestureBar',    role: 'gestureBar',    zone: 'bottomAction' }
        ]
      };

    case T.FIRST_DEPTH_LIST: {
      // Pick the search-bar theme ONCE per scene compose and share it with
      // the selection-dialog below so both alternate in sync (Figma
      // 629:1603 = light, 629:1602 = dark — pure black/white, no AI).
      var listTheme = Math.random() < 0.5 ? 'light' : 'dark';

      // Natural-sounding menu scenarios — rotated per scene so the user
      // sees realistic planning / recommendation / schedule content
      // instead of "This is a menu option" placeholders.
      var LIST_SCENARIOS = [
        {
          title: 'Summer travel plan',
          options: [
            'Jun 8-10 \u00b7 Jeju Island (3 days)',
            'Jul 15-22 \u00b7 Italy (1 week)',
            'Book Colosseum tour in Rome',
            'Hike Hallasan \u00b7 Witseoreum trail',
            'Sunscreen SPF50 + eye cream',
            'Book JAL flight (ICN \u2192 FCO)'
          ]
        },
        {
          title: 'Weekend plan \u00b7 Apr 27-28',
          options: [
            'Sat morning \u00b7 Brunch with Mom',
            'Sat afternoon \u00b7 MMCA exhibition',
            'Sat evening \u00b7 IU concert (Olympic Park)',
            'Sun lunch \u00b7 Bukchon hanok restaurant',
            'Sun afternoon \u00b7 Naksan Park sunset walk',
            'Mon morning \u00b7 Confirm reservation'
          ]
        },
        {
          title: 'Today\u2019s agenda \u00b7 Mon, Apr 20',
          options: [
            '10 AM \u00b7 Design team standup',
            '2 PM \u00b7 Q2 review presentation',
            '4 PM \u00b7 Coffee with Sarah',
            'Before EOD \u00b7 Finish project brief',
            'Workout \u00b7 Arms + core',
            'Return Mom\u2019s missed call'
          ]
        },
        {
          title: 'Saved Articles',
          options: [
            'The Future of Ambient UI',
            'Samsung One UI 8.5 deep dive',
            'Why designers write less now',
            'Jony Ive\'s next act, explained',
            'Building a type system at scale',
            'Galaxy S26 review — one year later'
          ]
        },
        {
          title: 'Shopping List · 6 items',
          options: [
            'MacBook Pro M4 14" · Space Black',
            'AirPods Pro 2 (USB-C)',
            'Samsung T7 Shield 2TB',
            'iPhone clear case w/ MagSafe',
            'Sony WH-1000XM5 (Black)',
            'Anker 737 power bank (24K mAh)'
          ]
        },
        {
          title: 'This week\u2019s bookings',
          options: [
            'Tue 7 PM \u00b7 Cheongdam omakase',
            'Wed 10 AM \u00b7 Dental checkup',
            'Thu 6 PM \u00b7 Pilates private lesson',
            'Fri 8 PM \u00b7 Dinner with the kids',
            'Sat 2 PM \u00b7 Gangnam hair salon',
            'Sun 11 AM \u00b7 Han River picnic (4)'
          ]
        }
      ];
      var pickedScenario = LIST_SCENARIOS[Math.floor(Math.random() * LIST_SCENARIOS.length)];

      return {
        surfaceType,
        components: [
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          // Compact Figma "Top" header (989:22761) — big time + date.
          // Replaces the old tall `expandable-app-bar` so search-bar and
          // selection-dialog sit higher with more breathing room.
          // Scenario title moved INTO list-top-bar (above time/date).
          // selection-dialog renders with showTitle:false so the title
          // isn't duplicated in both the header and the menu.
          { id: 'list-top-bar', role: 'list-top-bar', zone: 'viewing',
            variant: { title: pickedScenario.title } },
          { id: 'search-bar', role: 'search-bar', zone: 'viewing',
            variant: { style: listTheme } },
          { id: 'selection-dialog', role: 'selection-dialog', zone: 'interaction',
            variant: {
              theme: listTheme,
              showTitle: false,
              options: pickedScenario.options
            } },
          // Keep the pinned-apps dock on the bottom nav (same shortcuts as Home).
          { id: 'app-dock', role: 'app-dock', zone: 'bottomNav',
            content: { apps: ['Phone','Messages','Internet','Camera'] } }
        ]
      };
    }

    case T.SECOND_DEPTH_DETAIL: {
      // Detail — status-bar (restored) + list-top-bar rendered as TWO
      // lines (greeting title on line 1, time + date on line 2) so the
      // upper area feels balanced next to the stack of focus-blocks
      // below. A random greeting is picked on each generation so the
      // screen reads differently each time.
      var DETAIL_GREETINGS = [
        'Good morning, Kyuha',
        'Here\u2019s your day',
        'Today at a glance',
        'Daily briefing',
        'Welcome back'
      ];
      var detailGreet = DETAIL_GREETINGS[Math.floor(Math.random() * DETAIL_GREETINGS.length)];
      return {
        surfaceType,
        components: [
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'list-top-bar', role: 'list-top-bar', zone: 'viewing',
            variant: { title: detailGreet } },
          { id: 'hero-card',      role: 'focus-block', zone: 'viewing',
            variant: { kind: 'secondary',
              title: 'Morning routine',
              body: 'Weather + calendar preview so you can plan the day at a glance.' } },
          { id: 'secondary-card', role: 'focus-block', zone: 'viewing',
            variant: { kind: 'secondary',
              title: 'Now playing',
              body: 'Resume \u201cDaily Mix 1\u201d on Spotify. Queued: 27 tracks.' } },
          { id: 'tertiary-card',  role: 'focus-block', zone: 'viewing',
            variant: { kind: 'secondary',
              title: 'Coming up',
              body: 'Design review at 3:00 PM with Sarah and Alex. Notes attached.' } },
          { id: 'app-dock', role: 'app-dock', zone: 'bottomNav',
            content: { apps: ['Phone','Messages','Internet','Camera'] } }
        ]
      };
    }

    case T.TAB_ROOT:
      // Home screen — filled with app icon grid (no title, no card list).
      // app-grid expands to N individual app-icon nodes (editable each).
      // app-dock pins 4 shortcuts at the bottom.
      return {
        surfaceType,
        components: [
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'app-grid',   role: 'app-grid',   zone: 'interaction' },
          { id: 'app-dock',   role: 'app-dock',   zone: 'bottomNav',
            content: { apps: ['Phone','Messages','Internet','Camera'] } }
        ]
      };

    case T.DIALOG_BOTTOM:
      return {
        surfaceType,
        components: [
          { id: 'scrim', role: 'scrim', zone: 'full' },
          { id: 'dialog', role: 'bottom-dialog', zone: 'interaction' }
        ]
      };

    case T.DIALOG_CENTER:
      return {
        surfaceType,
        components: [
          { id: 'scrim', role: 'scrim', zone: 'full' },
          { id: 'dialog', role: 'center-dialog', zone: 'full' }
        ]
      };

    case T.QUICK_SETTINGS:
      return {
        surfaceType,
        components: [
          { id: 'qs-bg', role: 'background', zone: 'full' },
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'qs-panel', role: 'quick-settings-panel', zone: 'interaction' }
        ]
      };

    case T.NOTIFICATION_SHADE:
      return {
        surfaceType,
        components: [
          { id: 'shade-bg', role: 'background', zone: 'full' },
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'notif-list', role: 'notification-list', zone: 'interaction' }
        ]
      };

    case T.SELECTION_MODE:
      return {
        surfaceType,
        components: [
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'selection-app-bar', role: 'selection-app-bar', zone: 'viewing' },
          { id: 'selection-list', role: 'list', zone: 'interaction' },
          { id: 'selection-toolbar', role: 'bottom-bar', zone: 'bottomBar' }
        ]
      };

    default:
      return {
        surfaceType,
        components: [
          { id: 'status-bar', role: 'status-bar', zone: 'topSystem' },
          { id: 'app-bar', role: 'collapsed-app-bar', zone: 'viewing' },
          { id: 'content', role: 'detail-content', zone: 'interaction' }
        ]
      };
  }
};

// ============================================================================
// Container expansion — turn compositional roles (list, focus-block-group,
// detail-content) into individual editable nodes with real gaps.
// ============================================================================

// List-item preset pool — messaging-style rows with varied content
var LIST_ITEM_PRESETS = [
  { avatar: 'Messages.png',  title: 'Jimin',          subtitle: 'See you at 7 PM',            time: '2m',  badge: 3 },
  { avatar: null, glyph: 'M', accent: '#EA4335', title: 'Sarah Chen',   subtitle: 'Re: Q2 planning — let\u2019s sync', time: '12m' },
  { avatar: 'Contacts.png',  title: 'Hannah',         subtitle: '\u266B Voice message',        time: '1h',  badge: 1 },
  { avatar: null, glyph: 'S', accent: '#611F69', title: 'Alex (Slack)', subtitle: 'PR is ready for review',        time: '30m' },
  { avatar: 'Notes.png',     title: 'Maya',           subtitle: 'Added you to "Trip plan"',    time: '3h' },
  { avatar: null, glyph: 'D', accent: '#5865F2', title: 'Dev Community',subtitle: 'New message in #general',       time: '5h',  badge: 12 },
  { avatar: 'Gallery.png',   title: 'Tomas',          subtitle: 'Shared a photo',              time: '6h' },
  { avatar: null, glyph: 'F', accent: '#25D366', title: 'Family',       subtitle: 'Dad: Pickup at 6',              time: '1d' },
  { avatar: 'Clock.png',     title: 'Reminder',       subtitle: 'Call mom today',              time: '9h' },
  { avatar: null, glyph: 'W', accent: '#1DA1F2', title: 'Work',         subtitle: 'Standup tomorrow at 10',        time: '1d' }
];

function _randomList(pool, n) {
  var copy = pool.slice();
  for (var i = copy.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = copy[i]; copy[i] = copy[j]; copy[j] = t;
  }
  return copy.slice(0, Math.min(n, copy.length));
}

// Widget presets (for focus-block-group cells)
var WIDGET_PRESETS = [
  { kind: 'weather',  title: 'Seoul',        value: '18\u00B0',  accent: '#5AC8FA', sub: 'Partly cloudy' },
  { kind: 'battery',  title: 'Battery',      value: '69%',       accent: '#34C759', sub: '5h left' },
  { kind: 'activity', title: 'Steps',        value: '4,209',     accent: '#FF6B6B', sub: 'Goal 6,000' },
  { kind: 'music',    title: 'Now playing',  value: 'Dynamite',  accent: '#9B6BE6', sub: 'BTS' },
  { kind: 'calendar', title: 'Today',        value: '3 events',  accent: '#4285F4', sub: 'Next: 2pm stand-up' },
  { kind: 'alarm',    title: 'Alarm',        value: '7:00 AM',   accent: '#FF9500', sub: 'Weekday' }
];

window.expandContainerComponents = function expandContainerComponents(plan, layout) {
  if (!plan || !Array.isArray(plan.components)) return plan;
  var out = [];
  plan.components.forEach(function (comp) {
    var kids = null;
    if (comp.role === 'list')                kids = _expandList(comp, layout);
    else if (comp.role === 'notification-list') kids = _expandList(comp, layout); // same vertical stack
    else if (comp.role === 'focus-block-group') kids = _expandFocusBlockGroup(comp, layout);
    else if (comp.role === 'detail-content')  kids = _expandDetailContent(comp, layout);
    else if (comp.role === 'app-grid')        kids = _expandAppGrid(comp, layout);
    if (kids && kids.length) {
      out.push.apply(out, kids);
    } else {
      out.push(comp);
    }
  });
  plan.components = out;
  return plan;
};

// Home app grid — fills the space from below status-bar to above dock with
// a 4-column grid of app icons. Each cell becomes an editable `app-icon` node.
var HOME_APP_POOL = [
  'Phone', 'Messages', 'Camera', 'Gallery',
  'Contacts', 'Clock', 'Weather', 'Calculator',
  'Settings', 'Notes', 'Cloud', 'Health',
  'Reminder', 'Store', 'SmartThings', 'Bixby',
  'Internet', 'MyFiles', 'Studio', 'Wallet'
];

function _expandAppGrid(comp, layout) {
  var z = layout.zones;
  var leftX  = z.topSystem.x;
  var rightX = leftX + z.topSystem.w;
  var topY   = z.topSystem.y + z.topSystem.h + 12;        // below status bar
  var bottomY = z.bottomNav.y - 10;                        // above dock
  var gridW  = rightX - leftX;
  var gridH  = bottomY - topY;

  var cols   = 4;
  var colGap = 4;
  var labelH = 22;                                          // text row under icon
  var rowGap = 10;

  var cellW = Math.floor((gridW - colGap * (cols - 1)) / cols);
  var cellH = cellW + labelH;                              // icon area + label

  var rows = Math.max(1, Math.floor((gridH + rowGap) / (cellH + rowGap)));
  if (rows > 5) rows = 5;
  var total = Math.min(rows * cols, HOME_APP_POOL.length);

  // Center the grid vertically if there's leftover space
  var actualH = rows * cellH + (rows - 1) * rowGap;
  var startY = topY + Math.max(0, Math.floor((gridH - actualH) / 2));

  var result = [];
  for (var i = 0; i < total; i++) {
    var r = Math.floor(i / cols), c = i % cols;
    result.push({
      id: comp.id + ':app-' + i,
      role: 'app-icon',
      zone: comp.zone,
      _rect: {
        x: leftX + c * (cellW + colGap),
        y: startY + r * (cellH + rowGap),
        w: cellW,
        h: cellH
      },
      variant: { app: HOME_APP_POOL[i] }
    });
  }
  return result;
}

function _expandList(comp, layout) {
  var z = layout.zones[comp.zone] || layout.zones.interaction;
  var gap = (layout.metrics && layout.metrics.gap) || 8;
  var itemH = 72;  // One UI list-item default
  var maxCount = Math.max(1, Math.floor((z.h + gap) / (itemH + gap)));

  // Prefer agent-provided items when present — maps arbitrary shape into
  // our canonical list-item variant. Falls back to random presets otherwise.
  var agentItems = (comp.content && Array.isArray(comp.content.items))
    ? comp.content.items : null;

  var count, picked;
  if (agentItems && agentItems.length) {
    count = Math.min(agentItems.length, maxCount);
    picked = agentItems.slice(0, count).map(function (it) {
      it = it || {};
      return {
        title:    it.title    || it.name    || it.primary  || 'Item',
        subtitle: it.subtitle || it.secondary || it.description || it.body || '',
        time:     it.time     || it.timestamp || it.date   || '',
        avatar:   it.avatar   || it.icon     || null,
        glyph:    it.glyph    || null,
        accent:   it.accent   || null,
        badge:    it.badge    != null ? it.badge : undefined
      };
    });
  } else {
    count = Math.min(6, maxCount);
    picked = _randomList(LIST_ITEM_PRESETS, count);
  }

  var result = [];
  var y = z.y;
  for (var i = 0; i < count; i++) {
    result.push({
      id: comp.id + ':item-' + i,
      role: 'list-item',
      zone: comp.zone,
      _rect: { x: z.x, y: y, w: z.w, h: itemH },
      variant: picked[i] || {}
    });
    y += itemH + gap;
  }
  return result;
}

function _expandFocusBlockGroup(comp, layout) {
  var z = layout.zones[comp.zone] || layout.zones.interaction;
  var cols = 2, rows = 2;
  var gap = (layout.metrics && layout.metrics.gap) || 12;
  var cellW = Math.round((z.w - gap * (cols - 1)) / cols);
  // cap cell height so the group doesn't stretch the full zone
  var cellH = Math.min(110, Math.round((z.h - gap * (rows - 1)) / rows));
  var picked = _randomList(WIDGET_PRESETS, cols * rows);
  var result = [];
  for (var r = 0; r < rows; r++) {
    for (var c = 0; c < cols; c++) {
      var i = r * cols + c;
      result.push({
        id: comp.id + ':cell-' + i,
        role: 'focus-block',
        zone: comp.zone,
        _rect: {
          x: z.x + c * (cellW + gap),
          y: z.y + r * (cellH + gap),
          w: cellW,
          h: cellH
        },
        variant: picked[i] || {}
      });
    }
  }
  return result;
}

function _expandDetailContent(comp, layout) {
  var z = layout.zones[comp.zone] || layout.zones.interaction;
  var gap = (layout.metrics && layout.metrics.gap) || 12;
  var items = [];
  var y = z.y;

  // Agent-provided content (preferred) or fallback copy
  var c = comp.content || {};
  var heroTitle   = c.hero || c.title || 'Hero content';
  var titleText   = c.title || c.headline || 'Detail Title';
  var bodyParas   = Array.isArray(c.paragraphs) && c.paragraphs.length
    ? c.paragraphs
    : Array.isArray(c.body) ? c.body
    : (c.description
        ? [c.description]
        : [
            'Concise description of the detail — one or two lines that give the user the core of what they\u2019re looking at.',
            'A secondary paragraph with supporting info. Tap to expand for more context, reviews, or related items.'
          ]);
  var actions = c.actions || c.primaryAction
    ? {
        primary:   (c.actions && c.actions[0] && (c.actions[0].label || c.actions[0].text)) || c.primaryAction || 'Save',
        secondary: (c.actions && c.actions[1] && (c.actions[1].label || c.actions[1].text)) || c.secondaryAction || 'Share'
      }
    : { primary: 'Save', secondary: 'Share' };

  // Hero card (4:3 aspect)
  var heroH = Math.round(z.w * 0.6);
  items.push({
    id: comp.id + ':hero', role: 'focus-block', zone: comp.zone,
    _rect: { x: z.x, y: y, w: z.w, h: heroH },
    variant: { kind: 'hero', title: heroTitle }
  });
  y += heroH + gap;

  // Title block
  items.push({
    id: comp.id + ':title', role: 'paragraph', zone: comp.zone,
    _rect: { x: z.x, y: y, w: z.w, h: 48 },
    variant: { kind: 'title', text: titleText }
  });
  y += 48 + gap;

  // Body paragraphs (agent-provided or fallback)
  for (var p = 0; p < Math.min(bodyParas.length, 3) && (y + 52) <= z.y + z.h - 60; p++) {
    items.push({
      id: comp.id + ':para-' + p, role: 'paragraph', zone: comp.zone,
      _rect: { x: z.x, y: y, w: z.w, h: 52 },
      variant: { kind: 'body', text: bodyParas[p] }
    });
    y += 52 + gap;
  }

  // Action row
  items.push({
    id: comp.id + ':actions', role: 'action-row', zone: comp.zone,
    _rect: { x: z.x, y: y, w: z.w, h: 48 },
    variant: actions
  });

  return items;
}

window.resolveComponentRect = function resolveComponentRect(comp, layout, plan) {
  // If the container-expansion pass already computed a rect, use it as-is.
  if (comp._rect) return comp._rect;

  const z = layout.zones;
  const m = layout.metrics;
  const vw = layout.viewport.width;
  const vh = layout.viewport.height;

  switch (comp.role) {
    case 'status-bar':
      return {
        x: z.topSystem.x,
        y: z.topSystem.y,
        w: z.topSystem.w,
        h: z.topSystem.h
      };

    case 'expandable-app-bar':
      return {
        x: z.viewing.x,
        y: z.viewing.y,
        w: z.viewing.w,
        h: comp.state === 'expanded' ? m.appBarExpandedH : m.appBarCollapsedH
      };

    case 'collapsed-app-bar':
    case 'selection-app-bar':
      return {
        x: z.viewing.x,
        y: z.viewing.y,
        w: z.viewing.w,
        h: m.appBarCollapsedH
      };

    case 'search-bar':
      // Sits below the list-top-bar (80h + 8 gap). The top-bar now holds
      // a title line + time/date line so it's taller than before.
      return {
        x: z.viewing.x,
        y: z.viewing.y + 80 + 8,   // list-top-bar.bottom + 8
        w: z.viewing.w,
        h: 44
      };

    case 'focus-block': {
      // Sits below the list-top-bar (80h + 12 gap). Detail screen may
      // include up to THREE stacked focus-blocks — 'secondary-card' (or
      // 'hero-card-2') offsets below the first by 1× (fbH + 12 gap),
      // and 'tertiary-card' (or 'hero-card-3') offsets by 2×.
      var fbBaseY = z.viewing.y + 80 + 12;
      var fbH = 160;
      var fbY = fbBaseY;
      if (comp.id === 'secondary-card' || comp.id === 'hero-card-2') {
        fbY = fbBaseY + fbH + 12;
      } else if (comp.id === 'tertiary-card' || comp.id === 'hero-card-3') {
        fbY = fbBaseY + (fbH + 12) * 2;
      }
      return {
        x: z.viewing.x,
        y: fbY,
        w: z.viewing.w,
        h: fbH
      };
    }

    case 'focus-block-group':
      return {
        x: z.interaction.x,
        y: z.interaction.y,
        w: z.interaction.w,
        h: z.interaction.h - 12
      };

    case 'detail-content':
    case 'list':
    case 'notification-list':
      return {
        x: z.interaction.x,
        y: z.interaction.y,
        w: z.interaction.w,
        h: z.interaction.h
      };

    case 'list-top-bar':
      // Figma "Top" header (989:22761) + optional title line above.
      // Height 80: 30 for title + 4 gap + 35 for time/date + 11 pad.
      // When no title, still uses 80 so downstream positions stay stable.
      return {
        x: z.viewing.x,
        y: z.viewing.y,
        w: z.viewing.w,
        h: 80
      };

    case 'selection-dialog': {
      // Sits just below the search-bar on List screens. Starts at
      // (list-top-bar + 8 gap + search-bar + 16 gap) and extends through
      // the interaction zone so the 6 menu options have room to breathe.
      var sdY = z.viewing.y + 80 + 8 + 44 + 16; // top-bar(80) + gap + search-bar(44) + gap
      var sdH = (z.interaction.y + z.interaction.h) - sdY - 12;
      return {
        x: z.viewing.x,
        y: sdY,
        w: z.viewing.w,
        h: Math.max(200, sdH)
      };
    }

    case 'bottom-navigation':
    case 'app-dock':
      return {
        x: z.bottomNav.x,
        y: z.bottomNav.y,
        w: z.bottomNav.w,
        h: z.bottomNav.h
      };

    case 'app-grid':
      // Full content column between status bar and dock.
      return {
        x: z.topSystem.x,
        y: z.topSystem.y + z.topSystem.h + 12,
        w: z.topSystem.w,
        h: z.bottomNav.y - (z.topSystem.y + z.topSystem.h + 12) - 10
      };

    case 'bottom-bar':
      return {
        x: z.bottomBar.x,
        y: z.bottomBar.y,
        w: z.bottomBar.w,
        h: z.bottomBar.h
      };

    case 'bottom-dialog':
      return {
        x: 0,
        y: vh - 320,
        w: vw,
        h: 320
      };

    case 'center-dialog':
      return {
        x: Math.round(vw * 0.1),
        y: Math.round(vh * 0.38),
        w: Math.round(vw * 0.8),
        h: 220
      };

    case 'quick-settings-panel':
      return {
        x: 0,
        y: Math.round(vh * 0.16),
        w: vw,
        h: vh - Math.round(vh * 0.16)
      };

    // Canonical Samsung lockscreen atomics (names match Scene/Lock
    // template layers — see app/rules-renderer.js ROLE_RENDERERS).
    // Coordinates mirror the Figma Lock frame 451×978:
    //   lockIndicator y≈48  (small padlock icon, top center)
    //   weatherDate   y≈133 (condition + temp line above the clock)
    //   clock         y≈179 (huge center clock)
    //   shortcutLeft/Right = 47×47 circles in bottomNav zone corners
    //   gestureBar    = full-width 24h home indicator at very bottom
    case 'lockIndicator':
    case 'lock-indicator':   // kebab alias, same render target
      return {
        x: Math.round(vw / 2 - 12),
        y: z.topSystem.y + z.topSystem.h + 12,
        w: 24,
        h: 24
      };

    case 'weatherDate':
    case 'weather-date':
      return {
        x: z.viewing.x,
        y: z.viewing.y + 44,
        w: z.viewing.w,
        h: 28
      };

    case 'clock':
    case 'lock-clock':
    case 'lock-time':
      return {
        x: z.viewing.x,
        y: z.viewing.y + 78,
        w: z.viewing.w,
        h: 176
      };

    case 'lock-date':
      return {
        x: z.viewing.x,
        y: z.viewing.y + 262,
        w: z.viewing.w,
        h: 28
      };

    case 'shortcutLeft':
      return {
        x: z.bottomNav.x + 6,
        y: z.bottomNav.y + Math.round((z.bottomNav.h - 47) / 2),
        w: 47,
        h: 47
      };

    case 'shortcutRight':
      return {
        x: z.bottomNav.x + z.bottomNav.w - 47 - 6,
        y: z.bottomNav.y + Math.round((z.bottomNav.h - 47) / 2),
        w: 47,
        h: 47
      };

    case 'lock-shortcuts':   // legacy combined role
      return {
        x: z.bottomNav.x,
        y: z.bottomNav.y,
        w: z.bottomNav.w,
        h: z.bottomNav.h
      };

    case 'gestureBar':
      return {
        x: 0,
        y: vh - 24,
        w: vw,
        h: 24
      };

    case 'unlock-hint':
      return {
        x: z.bottomNav.x,
        y: (z.bottomNav.y || vh - 80) - 48,
        w: z.bottomNav.w,
        h: 32
      };

    case 'scrim':
    case 'background':
      return {
        x: 0,
        y: 0,
        w: vw,
        h: vh
      };

    default:
      return {
        x: z.interaction.x,
        y: z.interaction.y,
        w: 200,
        h: 60
      };
  }
};

// ── Token helpers (typography + glass + radius + spacing) ───────────────
// Thin wrappers that read from design_rules.json via Generator.* when loaded.
// Fallbacks are defensive for offline / early-boot rendering.
function _T(size, opts) {
  if (window.Generator && typeof window.Generator.typography === 'function') {
    return window.Generator.typography(size, opts || {});
  }
  // Display tier (Tier 1.3) — for hero card numbers/labels. display-xl
  // is the hottest signal on screen (hero weather temp, big ETA, etc.);
  // display-lg / display-md cover step-down hierarchy. Falls back to
  // headline/large for legacy callers.
  const pxMap = {
    micro:10, caption:12, label:14, body:15, title:16, heading:18, large:20,
    date:24, headline:26,
    'display-md': 32, 'display-lg': 40, 'display-xl': 56,
    hero:112
  };
  const weightMap = { regular:400, medium:500, semibold:600, bold:700 };
  const o = opts || {};
  var color = 'var(--text-primary,#fff)';
  if (o.color === 'translucentLabel') color = 'var(--text-secondary, rgba(255,255,255,0.7))';
  else if (o.color === 'sectionLabel') color = 'var(--text-tertiary, rgba(255,255,255,0.45))';
  return 'font-size:' + (pxMap[size] || 15) + 'px;font-weight:' + (weightMap[o.weight || 'regular']) + ';color:' + color + ';';
}
function _G(tier) {
  var __surfTier = _themeSurfaceStyleRoot();
  // Neon matches flat: single matte surface token — avoid the glass gradient stack.
  if (__surfTier === 'flat' || __surfTier === 'neon') {
    return 'background:var(--surface-bg, rgba(23,23,26,0.80));' +
      '-webkit-backdrop-filter:var(--surface-filter, blur(24px));backdrop-filter:var(--surface-filter, blur(24px));' +
      'border:var(--surface-border, 1px solid rgba(255,255,255,0.06));' +
      'box-shadow:var(--surface-shadow, none);';
  }
  // Default / 기본 프리셋: 단일 표면 레이어 + 토큰 기반 블러/테두리.
  // (구형 이중 레이어 `transparent, var(--surface-bg)` + color-mix 폴백은
  // 일부 브라우저에서 배경 전체가 빠져 카드가 투명해 보이는 경우가 있었음.)
  if (_themeSurfaceStyleRoot() === 'base') {
    return 'background:var(--surface-bg, rgba(23,23,26,0.60));' +
      '-webkit-backdrop-filter:var(--surface-filter, blur(48px));backdrop-filter:var(--surface-filter, blur(48px));' +
      'border:var(--surface-border, 1px solid rgba(255,255,255,0.12));' +
      'box-shadow:var(--surface-shadow, none);';
  }
  if (_themeSurfaceStyleRoot() === 'glass') {
    return 'background:var(--surface-overlay, transparent), var(--surface-bg, rgba(255,255,255,0.10));' +
      'background-size:var(--surface-bg-size, 160% 160%);' +
      '-webkit-backdrop-filter:var(--surface-filter, blur(42px) saturate(1.55));backdrop-filter:var(--surface-filter, blur(42px) saturate(1.55));' +
      'border:var(--surface-border, 1px solid rgba(255,255,255,0.34));' +
      'box-shadow:var(--surface-shadow, inset 0 1px 0 rgba(255,255,255,0.46), 0 22px 60px rgba(0,0,0,0.30));';
  }
  var fallback = tier === 'widgetPill'
    ? 'rgba(23,23,26,0.6)'
    : 'rgba(23,23,26,0.60)';
  return 'background:var(--surface-overlay, transparent), var(--surface-bg,' + fallback + ');' +
    'background-size:var(--surface-bg-size, auto);animation:var(--surface-animation, none);' +
    '-webkit-backdrop-filter:var(--surface-filter, blur(20px));backdrop-filter:var(--surface-filter, blur(20px));' +
    'border:var(--surface-border, 1px solid rgba(255,255,255,0.08));' +
    'box-shadow:var(--surface-shadow, none);';
}

// Inset tray / chrome fills inside dialog-shell. Quick Settings nests icon
// chips on a tinted surface — it does NOT stack a second full `_G('panel')`
// (duplicate backdrop-filter + gradients read as muddy / grey-blue vs QS).
function _GDialogInsetTray() {
  var s = _themeSurfaceStyleRoot();
  if (s === 'glass' || s === 'base') {
    return 'background:rgba(255,255,255,0.055);' +
      'border:var(--surface-border, 1px solid rgba(255,255,255,0.16));' +
      'box-shadow:inset 0 1px 0 rgba(255,255,255,0.14);';
  }
  if (s === 'flat' || s === 'neon') {
    return 'background:color-mix(in srgb,var(--surface-bg,#1a1a1c) 52%,transparent);' +
      'border:var(--surface-border, 1px solid rgba(255,255,255,0.06));';
  }
  return 'background:rgba(255,255,255,0.06);' +
    'border:var(--surface-border, 1px solid rgba(255,255,255,0.1));';
}

// Circular dialog chrome — aligned with QS `toggle-chip` off state (avoid
// color-mix on `--surface-bg` when the preset uses multi-stop gradients).
function _GDialogChromeCircle() {
  return 'background:var(--qs-chip-off-bg, rgba(180,180,180,0.2));' +
    'border:var(--surface-border, 1px solid rgba(255,255,255,0.12));' +
    'box-shadow:0 4px 12px rgba(0,0,0,0.14);';
}
function _R(tier) {
  if (window.Generator && typeof window.Generator.radius === 'function') {
    return window.Generator.radius(tier);
  }
  const rMap = { small:10, card:14, medium:18, widget:20, pill:32, dialog:36, panel:40, container:50, circle:63.636 };
  return (rMap[tier] != null ? rMap[tier] : 14) + 'px';
}
function _S(tier) {
  if (window.Generator && typeof window.Generator.spacing === 'function') {
    return window.Generator.spacing(tier);
  }
  const sMap = { xs:4, sm:6, md:8, base:10, lg:12, xl:14, xxl:16, '3xl':18, '4xl':20 };
  return (sMap[tier] != null ? sMap[tier] : 8) + 'px';
}
function _escHtmlText(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
}

// ── Weather icon — monochrome (Mono · Grayscale theme) ──────────────────
function _weatherIconSvgMonochrome(name) {
  var N = (name || 'sun').toLowerCase();
  var base = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">';
  var close = '</svg>';
  var hi = '#d4d4d8';
  var mid = '#9a9a9f';
  var lo = '#6f6f75';
  var cloud = '<path d="M7 17a4 4 0 0 1-1-7.87A6 6 0 0 1 17.5 8.5 4 4 0 0 1 17 17H7z" fill="' + lo + '"/>';
  var cloud2 = '<path d="M7 17a4 4 0 0 1-1-7.87A6 6 0 0 1 17.5 8.5 4 4 0 0 1 17 17H7z" fill="' + mid + '"/>';
  switch (N) {
    case 'sun':
    case 'clear':
      return base +
        '<circle cx="12" cy="12" r="4.5" fill="' + hi + '"/>' +
        '<g stroke="' + hi + '" stroke-width="2" stroke-linecap="round">' +
          '<path d="M12 2v2.5M12 19.5v2.5M2 12h2.5M19.5 12h2.5"/>' +
          '<path d="M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"/>' +
        '</g>' +
      close;
    case 'cloud-sun':
    case 'partly-cloudy':
      return base +
        '<circle cx="8" cy="7.5" r="3" fill="' + hi + '"/>' +
        '<g stroke="' + hi + '" stroke-width="1.5" stroke-linecap="round">' +
          '<path d="M8 2v1.5M2 7.5h1.5M3.5 3.5l1.06 1.06M12.5 3.5l-1.06 1.06M2.94 11.56l1.06-1.06"/>' +
        '</g>' +
        cloud +
      close;
    case 'cloud':
    case 'overcast':
      return base + cloud2 + close;
    case 'rain':
    case 'showers':
    case 'drizzle':
      return base +
        cloud2 +
        '<g stroke="' + mid + '" stroke-width="2" stroke-linecap="round">' +
          '<path d="M9 19v2.5M12 19.5v2M15 19v2.5"/>' +
        '</g>' +
      close;
    case 'snow':
    case 'sleet':
      return base +
        cloud +
        '<g fill="' + hi + '">' +
          '<circle cx="9" cy="20" r="1.2"/>' +
          '<circle cx="12" cy="21" r="1.2"/>' +
          '<circle cx="15" cy="20" r="1.2"/>' +
        '</g>' +
      close;
    case 'bolt':
    case 'storm':
    case 'thunderstorm':
      return base +
        cloud2 +
        '<path d="M12 18l-2 4h2.5l-1 4 4-6h-2.5l1-2z" fill="' + hi + '"/>' +
      close;
    case 'fog':
    case 'mist':
    case 'haze':
      return base +
        '<g stroke="' + mid + '" stroke-width="2" stroke-linecap="round">' +
          '<path d="M3 8h18M3 12h18M3 16h13M5 20h14"/>' +
        '</g>' +
      close;
    case 'wind':
    case 'windy':
      return base +
        '<g stroke="' + mid + '" stroke-width="2" stroke-linecap="round" fill="none">' +
          '<path d="M3 9h12a3 3 0 1 0-3-3"/>' +
          '<path d="M3 15h15a3 3 0 1 1-3 3"/>' +
        '</g>' +
      close;
    default:
      return base + cloud2 + close;
  }
}

// ── Weather icon glyph set ──────────────────────────────────────────────
// Returns an inline SVG string for the named weather condition. Sized to
// fill its container. Used by the focus-block weather variant. The colors
// are tuned to read on the dark glass card surface — sun is amber, cloud
// is light gray, rain is sky blue, snow is white-on-cloud, etc.
function _weatherIconSvg(name) {
  if (_isMonoChromaRoot()) {
    return _weatherIconSvgMonochrome(name);
  }
  const N = (name || 'sun').toLowerCase();
  const base = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">';
  const close = '</svg>';
  const cloud = '<path d="M7 17a4 4 0 0 1-1-7.87A6 6 0 0 1 17.5 8.5 4 4 0 0 1 17 17H7z" fill="#E5E7EB"/>';
  const cloudGray = '<path d="M7 17a4 4 0 0 1-1-7.87A6 6 0 0 1 17.5 8.5 4 4 0 0 1 17 17H7z" fill="#9CA3AF"/>';
  switch (N) {
    case 'sun':
    case 'clear':
      return base +
        '<circle cx="12" cy="12" r="4.5" fill="#FBBF24"/>' +
        '<g stroke="#FBBF24" stroke-width="2" stroke-linecap="round">' +
          '<path d="M12 2v2.5M12 19.5v2.5M2 12h2.5M19.5 12h2.5"/>' +
          '<path d="M4.93 4.93l1.77 1.77M17.3 17.3l1.77 1.77M4.93 19.07l1.77-1.77M17.3 6.7l1.77-1.77"/>' +
        '</g>' +
      close;
    case 'cloud-sun':
    case 'partly-cloudy':
      return base +
        '<circle cx="8" cy="7.5" r="3" fill="#FBBF24"/>' +
        '<g stroke="#FBBF24" stroke-width="1.5" stroke-linecap="round">' +
          '<path d="M8 2v1.5M2 7.5h1.5M3.5 3.5l1.06 1.06M12.5 3.5l-1.06 1.06M2.94 11.56l1.06-1.06"/>' +
        '</g>' +
        cloud +
      close;
    case 'cloud':
    case 'overcast':
      return base + cloud + close;
    case 'rain':
    case 'showers':
    case 'drizzle':
      return base +
        cloudGray +
        '<g stroke="#60A5FA" stroke-width="2" stroke-linecap="round">' +
          '<path d="M9 19v2.5M12 19.5v2M15 19v2.5"/>' +
        '</g>' +
      close;
    case 'snow':
    case 'sleet':
      return base +
        cloud +
        '<g fill="#fff">' +
          '<circle cx="9" cy="20" r="1.2"/>' +
          '<circle cx="12" cy="21" r="1.2"/>' +
          '<circle cx="15" cy="20" r="1.2"/>' +
        '</g>' +
      close;
    case 'bolt':
    case 'storm':
    case 'thunderstorm':
      return base +
        cloudGray +
        '<path d="M12 18l-2 4h2.5l-1 4 4-6h-2.5l1-2z" fill="#FBBF24"/>' +
      close;
    case 'fog':
    case 'mist':
    case 'haze':
      return base +
        '<g stroke="#9CA3AF" stroke-width="2" stroke-linecap="round">' +
          '<path d="M3 8h18M3 12h18M3 16h13M5 20h14"/>' +
        '</g>' +
      close;
    case 'wind':
    case 'windy':
      return base +
        '<g stroke="#9CA3AF" stroke-width="2" stroke-linecap="round" fill="none">' +
          '<path d="M3 9h12a3 3 0 1 0-3-3"/>' +
          '<path d="M3 15h15a3 3 0 1 1-3 3"/>' +
        '</g>' +
      close;
    default:
      return base + cloud + close;
  }
}

window.renderAtomicForRole = function renderAtomicForRole(comp, rect) {
  const A = window.GalaxyAtomics || {};

  switch (comp.role) {
    case 'status-bar':
      return A.StatusBar
        ? A.StatusBar({ theme: 'dark', battery: 69, carrier: 'K-Arts' })
        : '<div style="height:100%;display:flex;align-items:center;justify-content:space-between;' +
            _T('caption', { color: 'statusBar' }) +
          '"><span>12:45</span><span>69%</span></div>';

    case 'list-top-bar': {
      // Figma "Top" 989:22761 + optional title line.
      //   Line 1 (18/700): big bold title (e.g. scenario title)
      //   Line 2: 26/700 time "8:21" + 18/500 date "Thu 28 Aug" inline
      // When variant.title is empty, only the time/date line renders.
      var ltv = (comp && comp.variant) || {};
      var ltTitle = ltv.title || '';
      var now = new Date();
      var h = now.getHours();
      var mi = now.getMinutes();
      var timeStr = h + ':' + (mi < 10 ? '0' + mi : String(mi));
      var days = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];
      var mon  = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      var dateStr = days[now.getDay()] + ' ' + now.getDate() + ' ' + mon[now.getMonth()];
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:center;gap:8px;padding:0 10px;box-sizing:border-box;color:#fff;font-family:var(--font);">' +
        (ltTitle
          ? '<div style="font-size:22px;font-weight:700;letter-spacing:-0.1px;line-height:1.1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + ltTitle + '</div>'
          : '') +
        '<div style="display:flex;align-items:center;gap:20px;">' +
          '<span style="font-size:22px;font-weight:700;letter-spacing:0.22px;line-height:1;">' + timeStr + '</span>' +
          '<span style="font-size:15px;font-weight:500;letter-spacing:0.15px;line-height:1;opacity:0.9;">' + dateStr + '</span>' +
        '</div>' +
      '</div>';
    }

    case 'expandable-app-bar': {
      var abc = (comp && comp.content) || {};
      var abTitle = abc.title || comp.text || 'Title';
      var abSub   = abc.subtitle || '';
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;justify-content:flex-end;padding:0 0 ' + _S('lg') + ' 0;box-sizing:border-box;">' +
        '<div data-appbar-title="1" style="' +
          _T(comp.state === 'expanded' ? 'headline' : 'heading', { weight: 'bold' }) +
          'line-height:1.1;transition:font-size 220ms cubic-bezier(0.2,0,0,1), transform 220ms cubic-bezier(0.2,0,0,1);">' + abTitle + '</div>' +
        (abSub ? '<div style="' + _T('caption', { color: 'translucentLabel' }) + 'margin-top:2px;">' + abSub + '</div>' : '') +
      '</div>';
    }

    case 'collapsed-app-bar':
    case 'selection-app-bar': {
      var cabc = (comp && comp.content) || {};
      var cabTitle = cabc.title || comp.text || 'Title';
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:space-between;">' +
        '<span style="' + _T('heading', { weight: 'bold' }) + '">' + cabTitle + '</span>' +
        '<span style="' + _T('large') + 'opacity:0.7;">⋮</span>' +
      '</div>';
    }

    case 'selection-dialog': {
      // Figma SelectionDialog — node 629:1603 (light) / 629:1602 (dark).
      //   container: 354 wide, bg rgba(255,255,255,0.5) OR rgba(0,0,0,0.5),
      //              backdrop-blur 24, rounded 28, padding 24, gap 24
      //   title: 20/600 (bold), theme-colored
      //   options: 6 rows, 20/400, theme-colored, 30h each
      var sdv = (comp && comp.variant) || {};
      var sdTheme = sdv.theme === 'dark' ? 'dark' : 'light';
      var sdTitle = sdv.title || 'This is a menu title';
      var DEFAULT_OPTIONS = [
        'This is a menu option',
        'This is a menu option',
        'This is a menu option',
        'This is a menu option',
        'This is a menu option',
        'This is a menu option'
      ];
      var sdOptions = Array.isArray(sdv.options) ? sdv.options : DEFAULT_OPTIONS;
      var sdShowTitle = sdv.showTitle !== false;
      var sdBg, sdText;
      if (sdTheme === 'dark') {
        sdBg   = 'rgba(0,0,0,0.5)';
        sdText = '#ffffff';
      } else {
        sdBg   = 'rgba(255,255,255,0.5)';
        sdText = '#000000';
      }
      var titleHTML = sdShowTitle
        ? '<div data-shortcut="1" style="width:100%;padding:8px 0;display:flex;align-items:center;cursor:pointer;">' +
            '<span style="font-family:var(--font);font-size:20px;font-weight:600;color:' + sdText + ';">' + sdTitle + '</span>' +
          '</div>'
        : '';
      var optsHTML = sdOptions.map(function (opt) {
        return '<div data-shortcut="1" style="width:100%;padding:8px 0;display:flex;align-items:center;cursor:pointer;">' +
          '<span style="font-family:var(--font);font-size:20px;font-weight:400;color:' + sdText + ';">' + opt + '</span>' +
        '</div>';
      }).join('');
      return '<div style="width:100%;height:100%;box-sizing:border-box;' +
        'background:' + sdBg + ';' +
        '-webkit-backdrop-filter:blur(24px);backdrop-filter:blur(24px);' +
        'border-radius:28px;padding:24px;' +
        'display:flex;flex-direction:column;gap:24px;align-items:flex-start;overflow:hidden;">' +
        titleHTML +
        '<div style="display:flex;flex-direction:column;gap:24px;width:100%;align-items:flex-start;">' +
          optsHTML +
        '</div>' +
      '</div>';
    }

    // ========================================================================
    // DIALOG ATOMICS (Figma InternetPopOutMenu 3074:6464)
    //   dialog-shell        → rounded glass container (bg + 24px blur)
    //   dialog-site-header  → 50×50 thumb + title + URL + share icon row
    //   dialog-browser-bar  → 5 circular icon buttons with labels
    //   dialog-icon-grid    → 2×4 icon+label grid inside a glass box +
    //                          page-indicator dots
    // These mirror the Dialog overlay's rules-renderer counterparts
    // (app/rules-renderer.js: renderDialogShell/SiteHeader/BrowserBar/
    // IconGrid) so the Dialog overlay can render its components through
    // the same atomic library that backs the Design-tab palette.
    // ========================================================================
    case 'dialog-shell': {
      return '<div style="width:100%;height:100%;box-sizing:border-box;' + _G('panel') +
        'border-radius:' + _R('dialog') + ';"></div>';
    }

    case 'dialog-site-header': {
      var dshv = (comp && comp.variant) || {};
      var dshc = (comp && comp.content) || {};
      var dshTitle = _escHtmlText(dshv.siteName || dshv.title || dshc.label || 'One UI Design Kit');
      var dshUrl   = _escHtmlText(dshv.siteDesc || dshv.url || dshc.value || 'https://www.figma.com/community/file/oneui');
      var thumbBg = 'linear-gradient(135deg,color-mix(in srgb,var(--accent-primary,#4A5568) 45%,var(--surface-bg,#2D3748)),color-mix(in srgb,var(--text-secondary,#2D3748) 40%,transparent))';
      var shareBg = _GDialogChromeCircle();
      var divider = 'color-mix(in srgb,var(--text-primary,#fff) 14%,transparent)';
      return (
        '<div style="width:100%;height:100%;display:flex;flex-direction:column;gap:12px;padding:8px 8px 0;box-sizing:border-box;color:var(--text-primary,#fff);">' +
          '<div style="display:flex;align-items:center;gap:15px;">' +
            '<div style="width:50px;height:50px;border-radius:10px;background:' + thumbBg + ';flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);font-size:18px;font-weight:700;border:var(--surface-border, 1px solid rgba(255,255,255,0.08));">\u25A3</div>' +
            '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:6px;">' +
              '<div style="' + _T('title', { weight: 'semibold' }) + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1;">' + dshTitle + '</div>' +
              '<div style="' + _T('caption', { weight: 'regular', color: 'translucentLabel' }) + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;line-height:1;">' + dshUrl + '</div>' +
            '</div>' +
            '<div style="width:42px;height:42px;border-radius:14px;' + shareBg + 'flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);">' +
              '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M12 16V4M12 4l-4 4M12 4l4 4M4 14v4a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '</div>' +
          '</div>' +
          '<div style="height:1px;background:' + divider + ';width:100%;"></div>' +
        '</div>'
      );
    }

    case 'dialog-browser-bar': {
      var dbbv = (comp && comp.variant) || {};
      var dbbc = (comp && comp.content) || {};
      var DBB_ICON_INNER = {
        history: '<path d="M3 12a9 9 0 1 0 3-6.7L3 7M3 3v4h4M12 7v5l3.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        downloads: '<path d="M12 4v12M6 12l6 6 6-6M4 20h16" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        ai: '<path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5L12 3zM18 15l.9 2.2L21 18l-2.1.8L18 21l-.9-2.2L15 18l2.1-.8L18 15z" fill="currentColor"/>',
        add: '<path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        settings: '<circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.6"/><path d="M12 2v3M12 19v3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M2 12h3M19 12h3M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        search: '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>'
      };
      function _dbbInferInner(label, iconKey) {
        if (iconKey && DBB_ICON_INNER[iconKey]) return DBB_ICON_INNER[iconKey];
        var L = String(label || '');
        if (/history|recent/i.test(L)) return DBB_ICON_INNER.history;
        if (/download/i.test(L)) return DBB_ICON_INNER.downloads;
        if (/ai|galaxy|smart/i.test(L)) return DBB_ICON_INNER.ai;
        if (/add|new|\+/i.test(L)) return DBB_ICON_INNER.add;
        if (/setting|option/i.test(L)) return DBB_ICON_INNER.settings;
        if (/find|search/i.test(L)) return DBB_ICON_INNER.search;
        return DBB_ICON_INNER.history;
      }
      var DEFAULT_BROWSER_ACTIONS = [
        { label: 'History', icon: 'history' },
        { label: 'Downloads', icon: 'downloads' },
        { label: 'Galaxy AI', icon: 'ai' },
        { label: 'Add page', icon: 'add' },
        { label: 'Settings', icon: 'settings' }
      ];
      var rawShortcuts = Array.isArray(dbbv.shortcuts) ? dbbv.shortcuts
        : Array.isArray(dbbc.shortcuts) ? dbbc.shortcuts : null;
      if (!rawShortcuts || !rawShortcuts.length) {
        var mergeLbl = [dbbc.label, dbbc.value].filter(Boolean).join(' ');
        if (mergeLbl.trim()) {
          rawShortcuts = mergeLbl.split(/\s*[,/|·•]\s*/).map(function (s) { return { label: s.trim() }; }).filter(function (x) { return x.label; });
        }
      }
      var dbbActions = (rawShortcuts && rawShortcuts.length)
        ? rawShortcuts.slice(0, 8).map(function (s) {
          var lbl = String(s.label || s.name || '').trim();
          return {
            label: lbl,
            inner: _dbbInferInner(lbl, s.icon)
          };
        }).filter(function (a) { return a.label; })
        : DEFAULT_BROWSER_ACTIONS.map(function (a) {
          return { label: a.label, inner: DBB_ICON_INNER[a.icon] };
        });
      if (!dbbActions.length) {
        dbbActions = DEFAULT_BROWSER_ACTIONS.map(function (a) {
          return { label: a.label, inner: DBB_ICON_INNER[a.icon] };
        });
      }
      var circleShell = 'width:54px;height:54px;border-radius:48px;display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);' +
        _GDialogChromeCircle();
      var dbbCells = dbbActions.map(function (a) {
        var lab = _escHtmlText(a.label);
        return '<div data-shortcut="1" style="display:flex;flex-direction:column;align-items:center;gap:8px;cursor:pointer;color:var(--text-primary,#fff);">' +
          '<div style="' + circleShell + '"><svg width="24" height="24" viewBox="0 0 24 24" fill="none">' + a.inner + '</svg></div>' +
          '<div style="' + _T('caption', { weight: 'regular' }) + 'text-align:center;line-height:1.2;white-space:nowrap;">' + lab + '</div>' +
        '</div>';
      }).join('');
      return '<div style="width:100%;height:100%;display:flex;align-items:flex-start;justify-content:space-between;padding:0 8px;box-sizing:border-box;gap:' + _S('sm') + ';">' +
        dbbCells +
      '</div>';
    }

    case 'dialog-icon-grid': {
      var digv = (comp && comp.variant) || {};
      var digc = (comp && comp.content) || {};
      var DIG_GENERIC = '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/>';
      var DIG_PRESET = [
        { name: 'Videos',     svg: '<rect x="3" y="5" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M10 9l5 3-5 3V9z" fill="currentColor"/>' },
        { name: 'Extensions', svg: '<path d="M8 3v3h8V3M3 8h3v8H3M21 8h-3v8h3M8 21v-3h8v3M6 9v6h12V9H6z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>' },
        { name: 'Block ads',  svg: '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M5 5l14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
        { name: 'Privacy',    svg: '<path d="M12 3l7 3v5a9 9 0 0 1-7 9 9 9 0 0 1-7-9V6l7-3z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>' },
        { name: 'Brightness', svg: '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M5 19l2-2M17 7l2-2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
        { name: 'Find',       svg: '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M16 16l4 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
        { name: 'Text',       svg: '<path d="M5 6h14M12 6v14M9 20h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>' },
        { name: 'Save PDF',   svg: '<rect x="5" y="3" width="14" height="18" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M15 3v4h4M12 11v6M9 14l3 3 3-3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>' }
      ];
      function _digPickSvg(name) {
        var L = String(name || '').toLowerCase();
        if (/video|play/i.test(L)) return DIG_PRESET[0].svg;
        if (/extension|plugin/i.test(L)) return DIG_PRESET[1].svg;
        if (/ad|block/i.test(L)) return DIG_PRESET[2].svg;
        if (/privacy|shield/i.test(L)) return DIG_PRESET[3].svg;
        if (/bright/i.test(L)) return DIG_PRESET[4].svg;
        if (/find|search/i.test(L)) return DIG_PRESET[5].svg;
        if (/text|ocr/i.test(L)) return DIG_PRESET[6].svg;
        if (/pdf|save/i.test(L)) return DIG_PRESET[7].svg;
        return DIG_GENERIC;
      }
      var rawApps = Array.isArray(digv.apps) ? digv.apps
        : Array.isArray(digv.items) ? digv.items
        : Array.isArray(digc.apps) ? digc.apps
        : Array.isArray(digc.items) ? digc.items : null;
      var digApps;
      if (rawApps && rawApps.length) {
        digApps = rawApps.slice(0, 8).map(function (a) {
          var nm = String(a.name || a.label || '').trim();
          return {
            name: nm,
            svg: typeof a.svg === 'string' ? a.svg : _digPickSvg(nm)
          };
        }).filter(function (a) { return a.name; });
        for (var pi = digApps.length; pi < 8; pi++) {
          digApps.push(DIG_PRESET[pi]);
        }
      } else {
        digApps = DIG_PRESET.slice();
      }
      var dotActive = 'var(--accent-primary, #ffffff)';
      var dotIdle = 'color-mix(in srgb, var(--text-primary,#fff) 38%, transparent)';
      var digRow = function (slice) {
        return slice.map(function (a) {
          var nm = _escHtmlText(a.name);
          return '<div data-shortcut="1" style="width:54px;display:flex;flex-direction:column;align-items:center;gap:6px;cursor:pointer;color:var(--text-primary,#fff);">' +
            '<div style="width:40px;height:28px;display:flex;align-items:center;justify-content:center;"><svg width="24" height="24" viewBox="0 0 24 24" fill="none">' + a.svg + '</svg></div>' +
            '<div style="' + _T('caption', { weight: 'regular' }) + 'text-align:center;line-height:1.2;white-space:nowrap;">' + nm + '</div>' +
          '</div>';
        }).join('');
      };
      return (
        '<div style="width:100%;height:100%;box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;' + _GDialogInsetTray() +
          'border-radius:' + _R('medium') + ';padding:' + _S('xl') + ' ' + _S('xxl') + ' ' + _S('xl') + ';color:var(--text-primary,#fff);">' +
          '<div style="display:flex;justify-content:space-between;width:100%;">' + digRow(digApps.slice(0, 4)) + '</div>' +
          '<div style="display:flex;justify-content:space-between;width:100%;">' + digRow(digApps.slice(4, 8)) + '</div>' +
          '<div style="display:flex;justify-content:center;align-items:center;gap:6px;">' +
            '<div style="width:6px;height:6px;border-radius:5px;background:' + dotActive + ';"></div>' +
            '<div style="width:6px;height:6px;border-radius:5px;background:' + dotIdle + ';"></div>' +
          '</div>' +
        '</div>'
      );
    }

    case 'search-bar': {
      // Randomly picks one of 4 Figma search-bar variants + one of 10
      // natural-sounding prompts. Renders as an actual <input> so the
      // user can type — styled to match Figma exactly (bg/text/mic).
      //
      // Figma variants (kxDvBUif6pV502Si4RPidK):
      //   47:221  — dark solid (#17171a bg, white text)
      //   547:9639 — light solid (#fcfcff bg, black text)
      //   47:228  — Galaxy-AI dark gradient (with blue→green gradient text)
      //   547:9646 — Galaxy-AI light gradient
      //
      // variant.style can pin a specific one ('dark'|'light'|'ai-dark'|
      // 'ai-light'); otherwise it's random per render.
      var sbc = (comp && comp.content) || {};
      var sbv = (comp && comp.variant) || {};
      var SEARCH_PROMPTS = [
        'What are you searching for?',
        'What do you need?',
        'What would you like to find?',
        'What are you trying to find?',
        'What can I help you find?',
        'What do you have in mind?',
        'What are you here for?',
        'What are you after?',
        'What are you hoping to discover?',
        'What brings you here today?'
      ];
      var sbPh = sbc.placeholder || sbv.placeholder ||
        SEARCH_PROMPTS[Math.floor(Math.random() * SEARCH_PROMPTS.length)];

      var STYLES = ['dark', 'light', 'ai-dark', 'ai-light'];
      var sbStyle = sbv.style || STYLES[Math.floor(Math.random() * STYLES.length)];
      var __surfStyle = _themeSurfaceStyleRoot();
      if ((__surfStyle === 'flat' || __surfStyle === 'neon') && (sbStyle === 'ai-dark' || sbStyle === 'ai-light')) {
        sbStyle = 'dark';
      }

      // Common shell: 30px rounded pill, px-20 py-17, flex justify-between
      // with 24px mic icon on the right. Background + text color vary.
      var wrapBg, inputColor, inputBgClip, shadow, phColor;
      if (sbStyle === 'light') {
        wrapBg     = 'background:#fcfcff;';
        inputColor = 'color:#000000;';
        inputBgClip = '';
        shadow = '';
        phColor = '#000000';
      } else if (sbStyle === 'ai-dark') {
        wrapBg     = 'background:linear-gradient(to right,#364b6f 0%,#384247 64.807%,#2d2d30 87.168%);';
        inputColor = 'color:transparent;background:linear-gradient(to right,#66a1f3,#22c9a6);-webkit-background-clip:text;background-clip:text;';
        inputBgClip = '';
        shadow = 'box-shadow:-1px 0 4px 1px rgba(78,102,139,0.58);';
        phColor = 'transparent'; // gradient via ::placeholder workaround below
      } else if (sbStyle === 'ai-light') {
        wrapBg     = 'background:linear-gradient(to right,#364b6f 0%,#91b0bf 64.807%,#cfcfcf 87.168%);';
        inputColor = 'color:transparent;background:linear-gradient(to right,#66a1f3,#22c9a6);-webkit-background-clip:text;background-clip:text;';
        inputBgClip = '';
        shadow = 'box-shadow:-1px 0 4px 1px rgba(78,102,139,0.58);';
        phColor = 'transparent';
      } else {
        // dark (default)
        wrapBg     = 'background:#17171a;';
        inputColor = 'color:#ffffff;';
        inputBgClip = '';
        shadow = '';
        phColor = '#ffffff';
      }

      // Unique ID so multiple search-bars on one page don't collide.
      var inputId = 'searchbar-' + Math.random().toString(36).slice(2, 8);
      var isAI = sbStyle === 'ai-dark' || sbStyle === 'ai-light';

      // Mic icon — 24×24, inherits wrap text color (stroke currentColor)
      var micColor = (sbStyle === 'light') ? '#000000' : '#ffffff';
      var micSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;color:' + micColor + ';"><rect x="9" y="3" width="6" height="11" rx="3" fill="currentColor"/><path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/></svg>';

      // For AI variants, use a separate span that renders the gradient text
      // AND a transparent real input on top for typing. The span shows the
      // placeholder when empty; hidden when user types.
      if (isAI) {
        return '<div style="width:100%;height:100%;' + wrapBg + shadow +
          'border-radius:30px;padding:17px 20px;box-sizing:border-box;' +
          'display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;position:relative;">' +
          '<div style="flex:1;min-width:0;position:relative;height:22px;">' +
            // Gradient placeholder (shown when input is empty)
            '<span data-sb-gradient-placeholder style="position:absolute;inset:0;display:flex;align-items:center;' +
              'font-family:var(--font);font-size:16px;font-weight:600;line-height:1;' +
              'background:linear-gradient(to right,#66a1f3,#22c9a6);-webkit-background-clip:text;background-clip:text;color:transparent;' +
              'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;pointer-events:none;">' + sbPh + '</span>' +
            // Real input (transparent text so user sees gradient placeholder,
            // switches to own text once they type)
            '<input id="' + inputId + '" type="text" ' +
              'oninput="this.previousElementSibling.style.display=this.value?\'none\':\'flex\';" ' +
              'style="width:100%;height:100%;background:transparent;border:none;outline:none;' +
              'font-family:var(--font);font-size:16px;font-weight:600;' +
              'background:linear-gradient(to right,#66a1f3,#22c9a6);-webkit-background-clip:text;background-clip:text;-webkit-text-fill-color:transparent;' +
              'caret-color:#66a1f3;padding:0;margin:0;"/>' +
          '</div>' +
          micSvg +
        '</div>';
      }

      // Solid variants (dark / light)
      return '<div style="width:100%;height:100%;' + wrapBg +
        'border-radius:30px;padding:17px 20px;box-sizing:border-box;' +
        'display:flex;align-items:center;justify-content:space-between;gap:8px;overflow:hidden;">' +
        '<input id="' + inputId + '" type="text" placeholder="' + sbPh + '" ' +
          'style="flex:1;min-width:0;height:22px;background:transparent;border:none;outline:none;' +
          'font-family:var(--font);font-size:16px;font-weight:600;' + inputColor + 'padding:0;margin:0;' +
          '--sb-ph:' + phColor + ';"/>' +
        micSvg +
      '</div>';
    }

    case 'focus-block': {
      // Variant-aware: widget cells, hero cards, 'secondary' editorial
      // cards, weather cards, or default focus
      var fv = (comp && comp.variant) || {};
      var ftitle = fv.title || 'Focus block';
      var fvalue = fv.value || '';
      var fbody  = fv.body || fv.description || '';
      var fsub   = fv.sub   || (fv.kind === 'hero' ? '' : 'Important content goes here');
      var faccent = fv.accent || 'var(--accent-primary,#0381FE)';

      // Calendar variant — dedicated visual treatment so
      // calendar_summary_card doesn't render as a generic banner. Layout:
      // small section header ("Next up · Today") + small calendar glyph
      // beside a prominent time block, then event title large, location
      // with pin icon at the bottom.
      if (fv.kind === 'calendar') {
        var cTime     = fv.time     || '';
        var cTitle    = fv.title    || 'Event';
        var cLocation = fv.location || '';
        var cDuration = fv.duration || '';
        var cSection  = fv.section  || '';
        // Inline calendar glyph (24x24, fills container) — uses theme
        // accent color so a "vibrant" or "mono" theme recolors it.
        var calIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<rect x="3" y="5" width="18" height="16" rx="3" stroke="var(--card-calendar-accent,#A78BFA)" stroke-width="1.8" fill="color-mix(in srgb, var(--card-calendar-accent,#A78BFA) 15%, transparent)"/>' +
          '<path d="M8 3v4M16 3v4M3 10h18" stroke="var(--card-calendar-accent,#A78BFA)" stroke-width="1.8" stroke-linecap="round"/>' +
          '<circle cx="8" cy="14" r="1.2" fill="var(--card-calendar-accent,#A78BFA)"/>' +
          '<circle cx="12" cy="14" r="1.2" fill="var(--card-calendar-accent,#A78BFA)"/>' +
        '</svg>';
        // Pin glyph for location (smaller)
        var pinIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<path d="M12 22s7-7.58 7-13a7 7 0 0 0-14 0c0 5.42 7 13 7 13z" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" fill="none"/>' +
          '<circle cx="12" cy="9" r="2.2" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>' +
        '</svg>';
        // Build header row (section + duration meta, optional)
        var headerParts = [];
        if (cSection)  headerParts.push('<span>' + cSection + '</span>');
        if (cSection && cDuration) headerParts.push('<span style="opacity:0.5;">·</span>');
        if (cDuration) headerParts.push('<span>' + cDuration + '</span>');
        var headerRow = headerParts.length
          ? '<div style="' + _T('micro', { color: 'translucentLabel' }) + 'display:flex;gap:' + _S('xs') + ';align-items:center;letter-spacing:0.4px;text-transform:uppercase;">' + headerParts.join('') + '</div>'
          : '';
        // Build time + cal-icon row
        var timeRow = '<div style="display:flex;align-items:center;gap:' + _S('md') + ';">' +
          '<div style="width:18px;height:18px;flex-shrink:0;opacity:0.9;">' + calIcon + '</div>' +
          (cTime ? '<div style="font-family:var(--font);font-size:min(var(--card-calendar-time-size,22px),20px);font-weight:var(--card-calendar-time-weight,600);line-height:1;color:var(--text-primary,#fff);letter-spacing:-0.25px;">' + cTime + '</div>' : '') +
        '</div>';
        // Location row with pin
        var locRow = cLocation
          ? '<div style="display:flex;align-items:center;gap:' + _S('xs') + ';">' +
              '<div style="width:12px;height:12px;flex-shrink:0;opacity:0.7;">' + pinIcon + '</div>' +
              '<div style="' + _T('caption', { color: 'translucentLabel' }) + '">' + cLocation + '</div>' +
            '</div>'
          : '';
        return '<div style="width:100%;min-height:120px;height:100%;border-radius:18px;' +
          _G('panel') +
          'padding:16px 20px;box-sizing:border-box;' +
          'display:flex;flex-direction:column;justify-content:center;gap:7px;overflow:hidden;position:relative;">' +
          '<div style="position:relative;z-index:1;display:flex;flex-direction:column;justify-content:center;gap:7px;min-height:0;">' +
            headerRow +
            timeRow +
            '<div style="' + _T('body', { weight: 'semibold' }) + 'line-height:1.22;display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;">' + cTitle + '</div>' +
            locRow +
          '</div>' +
        '</div>';
      }

      // Input-summary variant — for `input_summary_card`. Layout: a small
      // form-input glyph in the corner, section header (uppercase), large
      // topic phrase, and either a single detail line OR a row of facet
      // chips when the value contained separators. Used for search recap,
      // settings change confirmation, address entry summary.
      if (fv.kind === 'input') {
        var iSection = fv.section || 'INPUT';
        var iTopic   = fv.topic   || '';
        var iDetail  = fv.detail  || '';
        var iFacets  = Array.isArray(fv.facets) ? fv.facets : [];
        // Form-input glyph (search bar with text-line)
        var formIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<rect x="3" y="6" width="18" height="12" rx="3" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>' +
          '<path d="M7 12h6" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-linecap="round"/>' +
          '<circle cx="17" cy="12" r="0.8" fill="rgba(255,255,255,0.6)"/>' +
        '</svg>';
        // Long-facet detection — if any facet exceeds ~28 chars, the chip
        // pattern looks bad (long pill that overflows the card). Fall
        // back to a plain detail line in that case (the LLM's value as
        // body text). Short facets (<=28) render as proper chip row.
        var FACET_MAX_LEN  = 28;
        var hasLongFacet   = iFacets.some(function (f) { return (f || '').length > FACET_MAX_LEN; });
        var useChipRow     = iFacets.length > 0 && !hasLongFacet;
        // Render facet chips — only when all facets are short enough.
        // flex-wrap:wrap so multiple chips stack to a new line if the
        // sum exceeds card width. flex-shrink:1 + max-width so a single
        // chip can compress before overflowing.
        var facetHtml = !useChipRow ? '' :
          iFacets.slice(0, 4).map(function (f) {
            return '<span style="padding:4px 9px;background:rgba(255,255,255,0.1);border-radius:14px;' +
              _T('caption', { weight: 'medium' }) +
              'max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;flex-shrink:1;">' + f + '</span>';
          }).join('');
        // Detail-line fallback: join all facets with separator, render
        // as a 2-line clamped paragraph. Keeps the info accessible even
        // if it can't fit as chips.
        var detailLine = iDetail || (hasLongFacet ? iFacets.join(' · ') : '');
        return '<div style="width:100%;min-height:116px;height:100%;border-radius:18px;' +
          _G('panel') +
          'padding:16px 20px;box-sizing:border-box;' +
          'display:flex;flex-direction:column;justify-content:center;gap:7px;overflow:hidden;">' +
          // Header: form-icon + section
          '<div style="display:flex;align-items:center;gap:' + _S('md') + ';">' +
            '<div style="width:18px;height:18px;flex-shrink:0;opacity:0.85;">' + formIcon + '</div>' +
            '<div style="' + _T('micro', { color: 'translucentLabel' }) + 'letter-spacing:0.4px;text-transform:uppercase;">' + iSection + '</div>' +
          '</div>' +
          // Body: topic (large) — what the user input was about
          (iTopic
            ? '<div style="font-size:min(var(--card-input-topic-size,20px),18px);font-weight:600;line-height:1.2;color:var(--text-primary,#fff);display:-webkit-box;-webkit-line-clamp:1;-webkit-box-orient:vertical;overflow:hidden;margin-bottom:2px;">' + iTopic + '</div>'
            : '') +
          // Footer: chip row when all facets are short, otherwise a
          // 2-line clamped detail paragraph.
          (useChipRow
            ? '<div style="display:flex;gap:' + _S('xs') + ';flex-wrap:wrap;overflow:hidden;max-width:100%;margin-top:0;">' + facetHtml + '</div>'
            : (detailLine
              ? '<div style="' + _T('label', { color: 'translucentLabel' }) + 'line-height:1.4;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + detailLine + '</div>'
              : '')) +
        '</div>';
      }

      // Reminder variant — checkbox + task title + due time, with an
      // orange accent for the section header. Sample Samsung One UI
      // reminder widget layout.
      if (fv.kind === 'reminder') {
        var rTask    = fv.task    || 'Reminder';
        var rDue     = fv.due     || '';
        var rSection = fv.section || (fv.count ? fv.count + ' ITEMS' : 'TODAY');
        // Hollow checkbox SVG — accent driven by theme var
        var checkBox = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<rect x="4" y="4" width="16" height="16" rx="4" stroke="var(--card-reminder-accent,#F59E0B)" stroke-width="1.8" fill="color-mix(in srgb, var(--card-reminder-accent,#F59E0B) 12%, transparent)"/>' +
        '</svg>';
        var clockIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<circle cx="12" cy="12" r="9" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>' +
          '<path d="M12 7v5l3 2" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" stroke-linecap="round"/>' +
        '</svg>';
        return '<div style="width:100%;min-height:104px;height:100%;border-radius:18px;' +
          _G('panel') +
          'padding:16px 20px;box-sizing:border-box;' +
          'display:flex;flex-direction:column;justify-content:center;gap:7px;overflow:hidden;">' +
          // Header: checkbox + section
          '<div style="display:flex;align-items:center;gap:' + _S('md') + ';">' +
            '<div style="width:18px;height:18px;flex-shrink:0;">' + checkBox + '</div>' +
            '<div style="' + _T('micro', { color: 'translucentLabel' }) + 'letter-spacing:0.4px;text-transform:uppercase;">' + rSection + '</div>' +
          '</div>' +
          // Task title
          '<div style="font-size:min(var(--card-reminder-task-size,16px),15px);font-weight:600;line-height:1.25;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;color:var(--text-primary,#fff);">' + rTask + '</div>' +
          // Due time row
          (rDue
            ? '<div style="display:flex;align-items:center;gap:' + _S('xs') + ';">' +
                '<div style="width:12px;height:12px;flex-shrink:0;">' + clockIcon + '</div>' +
                '<div style="' + _T('caption', { color: 'translucentLabel' }) + '">Due ' + rDue + '</div>' +
              '</div>'
            : '') +
        '</div>';
      }

      // Message summary variant — avatar circle + sender + preview.
      // Green accent for "new messages" section header.
      if (fv.kind === 'message') {
        var mSender  = fv.sender  || '';
        var mPreview = fv.preview || '(no preview)';
        var mSection = fv.section || 'MESSAGES';
        // Avatar — colored circle with first letter of sender (or chat
        // bubble glyph when no sender)
        var avatarLetter = mSender ? mSender.charAt(0).toUpperCase() : '';
        var avatar = avatarLetter
          ? '<div style="width:min(var(--card-message-avatar-size,32px),28px);height:min(var(--card-message-avatar-size,32px),28px);border-radius:50%;background:var(--card-message-avatar-grad,linear-gradient(135deg,#34D399,#10B981));display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);font-weight:600;font-size:12px;flex-shrink:0;">' + avatarLetter + '</div>'
          : '<div style="width:min(var(--card-message-avatar-size,32px),28px);height:min(var(--card-message-avatar-size,32px),28px);border-radius:50%;background:var(--card-message-avatar-grad,linear-gradient(135deg,#34D399,#10B981));display:flex;align-items:center;justify-content:center;flex-shrink:0;">' +
              '<svg width="18" height="18" viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 1 1-3.5-6.6L21 4l-1.4 3.5A8 8 0 0 1 21 12z" fill="#fff"/></svg>' +
            '</div>';
        return '<div style="width:100%;min-height:104px;height:100%;border-radius:18px;' +
          _G('panel') +
          'padding:16px 20px;box-sizing:border-box;' +
          'display:flex;flex-direction:column;justify-content:center;gap:7px;overflow:hidden;">' +
          // Header
          '<div style="' + _T('micro', { color: 'translucentLabel' }) + 'letter-spacing:0.4px;text-transform:uppercase;">' + mSection + '</div>' +
          // Body: avatar + (sender + preview)
          '<div style="display:flex;align-items:flex-start;gap:10px;">' +
            avatar +
            '<div style="flex:1;min-width:0;">' +
              (mSender
                ? '<div style="' + _T('title', { weight: 'semibold' }) + 'line-height:1.2;margin-bottom:' + _S('xs') + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mSender + '</div>'
                : '') +
              '<div style="' + _T('caption', { color: 'translucentLabel' }) + 'line-height:1.35;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;">' + mPreview + '</div>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      // ETA variant — route icon + large duration + destination + traffic.
      // Teal accent for the navigation context.
      if (fv.kind === 'eta') {
        var eEta         = fv.eta         || '—';
        var eDestination = fv.destination || '';
        var eTraffic     = fv.traffic     || '';
        var eRoute       = fv.route       || '';
        // Trafficaccent: green for light, amber for moderate, red for heavy
        var trafficColor = '#10B981';  // light (default)
        if (/heavy|severe/i.test(eTraffic)) trafficColor = '#EF4444';
        else if (/moderate/i.test(eTraffic)) trafficColor = '#F59E0B';
        var carIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<path d="M5 17h14M7 17l1.5-5h7L17 17M6 17v2M18 17v2" stroke="var(--card-eta-accent,#14B8A6)" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>' +
          '<circle cx="9" cy="14" r="0.8" fill="var(--card-eta-accent,#14B8A6)"/>' +
          '<circle cx="15" cy="14" r="0.8" fill="var(--card-eta-accent,#14B8A6)"/>' +
        '</svg>';
        var pinIcon = '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none" style="display:block;">' +
          '<path d="M12 22s7-7.58 7-13a7 7 0 0 0-14 0c0 5.42 7 13 7 13z" stroke="rgba(255,255,255,0.6)" stroke-width="1.5" fill="none"/>' +
          '<circle cx="12" cy="9" r="2.2" stroke="rgba(255,255,255,0.6)" stroke-width="1.5"/>' +
        '</svg>';
        return '<div style="width:100%;min-height:104px;height:100%;border-radius:18px;' +
          _G('panel') +
          'padding:16px 20px;box-sizing:border-box;' +
          'display:flex;flex-direction:column;justify-content:center;gap:7px;overflow:hidden;">' +
          // Top: car icon + huge ETA
          '<div style="display:flex;align-items:center;gap:' + _S('lg') + ';">' +
            '<div style="width:min(var(--card-eta-icon-size,32px),24px);height:min(var(--card-eta-icon-size,32px),24px);flex-shrink:0;">' + carIcon + '</div>' +
            '<div style="font-family:var(--font);font-size:min(var(--card-eta-size,40px),30px);font-weight:600;line-height:1;color:var(--text-primary,#fff);letter-spacing:-0.7px;">' + eEta + '</div>' +
          '</div>' +
          // Mid: destination
          (eDestination
            ? '<div style="display:flex;align-items:center;gap:' + _S('xs') + ';">' +
                '<div style="width:14px;height:14px;flex-shrink:0;opacity:0.7;">' + pinIcon + '</div>' +
                '<div style="' + _T('title', { weight: 'medium' }) + 'line-height:1.2;">' + eDestination + '</div>' +
              '</div>'
            : '') +
          // Bottom: traffic indicator
          (eTraffic
            ? '<div style="display:flex;align-items:center;gap:' + _S('xs') + ';">' +
                '<span style="width:8px;height:8px;border-radius:50%;background:' + trafficColor + ';flex-shrink:0;"></span>' +
                '<span style="' + _T('caption', { color: 'translucentLabel' }) + '">' + eTraffic + (eRoute ? ' · ' + eRoute : '') + '</span>' +
              '</div>'
            : (eRoute
              ? '<div style="' + _T('caption', { color: 'translucentLabel' }) + '">' + eRoute + '</div>'
              : '')) +
        '</div>';
      }

      // Tier 2.1 — Condition-aware background gradient for weather cards.
      // Replaces the flat glass surface with a dynamic sky-like color
      // that responds to the weather condition. Real Samsung weather
      // widgets use full-card imagery; this is a CSS-only equivalent
      // (no network calls, no images to load) that captures ~60% of
      // the visual richness for ~5% of the cost.
      function _weatherBgGradient(icon) {
        var I = (icon || '').toLowerCase();
        // Strong, visible gradients — these are the weather card's
        // identity. Previously too subtle (0.18-0.32 alpha); bumped
        // to 0.45-0.65 so the sun/cloud/rain identity reads at a
        // glance. Final stop blends to dark surface so text contrast
        // stays readable.
        switch (I) {
          case 'sun':
          case 'clear':
            return 'linear-gradient(155deg, rgba(251,191,36,0.62) 0%, rgba(249,115,22,0.40) 55%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'cloud-sun':
          case 'partly-cloudy':
            return 'linear-gradient(155deg, rgba(251,191,36,0.48) 0%, rgba(180,180,195,0.30) 50%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'cloud':
          case 'overcast':
            return 'linear-gradient(155deg, rgba(180,180,195,0.42) 0%, rgba(120,125,140,0.28) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'rain':
          case 'showers':
          case 'drizzle':
            return 'linear-gradient(155deg, rgba(96,165,250,0.55) 0%, rgba(51,65,85,0.35) 55%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'snow':
          case 'sleet':
            return 'linear-gradient(155deg, rgba(226,232,240,0.55) 0%, rgba(148,163,184,0.32) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'bolt':
          case 'storm':
          case 'thunderstorm':
            return 'linear-gradient(155deg, rgba(251,191,36,0.40) 0%, rgba(71,85,105,0.55) 45%, color-mix(in srgb, var(--page-bg,#171717) 78%, transparent) 100%)';
          case 'fog':
          case 'mist':
          case 'haze':
            return 'linear-gradient(155deg, rgba(180,180,195,0.36) 0%, rgba(120,125,140,0.26) 50%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'wind':
          case 'windy':
            return 'linear-gradient(155deg, rgba(165,180,252,0.45) 0%, rgba(120,125,140,0.28) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          default:
            return '';
        }
      }

      /** Grayscale-only sky fills when `--oneui-chroma: mono` is active. */
      function _weatherBgGradientMono(icon) {
        var I = (icon || '').toLowerCase();
        switch (I) {
          case 'sun':
          case 'clear':
            return 'linear-gradient(155deg, rgba(205,205,210,0.40) 0%, rgba(125,125,130,0.30) 55%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'cloud-sun':
          case 'partly-cloudy':
            return 'linear-gradient(155deg, rgba(185,185,190,0.36) 0%, rgba(110,110,115,0.28) 50%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'cloud':
          case 'overcast':
            return 'linear-gradient(155deg, rgba(155,155,160,0.38) 0%, rgba(85,85,90,0.26) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'rain':
          case 'showers':
          case 'drizzle':
            return 'linear-gradient(155deg, rgba(145,148,155,0.40) 0%, rgba(65,68,74,0.32) 55%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'snow':
          case 'sleet':
            return 'linear-gradient(155deg, rgba(210,210,215,0.42) 0%, rgba(130,132,138,0.30) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'bolt':
          case 'storm':
          case 'thunderstorm':
            return 'linear-gradient(155deg, rgba(175,175,180,0.36) 0%, rgba(70,72,78,0.34) 45%, color-mix(in srgb, var(--page-bg,#171717) 78%, transparent) 100%)';
          case 'fog':
          case 'mist':
          case 'haze':
            return 'linear-gradient(155deg, rgba(150,150,155,0.34) 0%, rgba(88,90,95,0.26) 50%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          case 'wind':
          case 'windy':
            return 'linear-gradient(155deg, rgba(165,165,172,0.36) 0%, rgba(95,98,105,0.28) 60%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
          default:
            return 'linear-gradient(155deg, rgba(170,170,176,0.36) 0%, rgba(95,95,100,0.28) 55%, color-mix(in srgb, var(--page-bg,#171717) 72%, transparent) 100%)';
        }
      }

      // Weather variant — dedicated visual treatment so weather_glance_card
      // doesn't render as a generic title+sub box. Layout: condition icon
      // beside a large temp number, condition phrase below, location +
      // feels-like meta at the bottom. THEME-DRIVEN: every visual property
      // pulls from a CSS variable (e.g. --card-weather-temp-size) so the
      // /customize dropdown can swap the entire visual identity at runtime
      // without touching this code.
      if (fv.kind === 'weather') {
        var wTemp      = fv.temp      || '—';
        var wCondition = fv.condition || '';
        var wLocation  = fv.location  || '';
        var wFeels     = fv.feels     || '';
        var wIcon      = _weatherIconSvg(fv.icon || 'sun');
        var themeSurface = _themeSurfaceStyleRoot();
        var wDate = fv.date || 'Tue, Apr 14';
        var wTime = fv.time || '3:16';
        var wWind = fv.wind || 'Wind 5 mph';
        var wBgStyle;
        if (_isMonoChromaRoot()) {
          wBgStyle = 'background:linear-gradient(180deg,rgba(111,111,117,0.86) 0%,rgba(155,155,160,0.78) 100%), color-mix(in srgb, var(--page-bg,#171717) 26%, transparent);-webkit-backdrop-filter:blur(18px) saturate(1.12);backdrop-filter:blur(18px) saturate(1.12);border:1px solid rgba(255,255,255,0.18);box-shadow:inset 0 1px 0 rgba(255,255,255,0.22), var(--surface-shadow, none);';
        } else if (themeSurface === 'flat' || themeSurface === 'neon') {
          wBgStyle = 'background:var(--surface-bg, rgba(23,23,26,0.80));-webkit-backdrop-filter:var(--surface-filter, blur(24px));backdrop-filter:var(--surface-filter, blur(24px));border:var(--surface-border, 1px solid rgba(255,255,255,0.06));box-shadow:var(--surface-shadow, none);';
        } else if (themeSurface === 'base') {
          wBgStyle = 'background:linear-gradient(180deg,rgba(63,136,221,0.86) 0%,rgba(112,177,230,0.78) 100%), color-mix(in srgb, var(--page-bg,#171717) 28%, transparent);-webkit-backdrop-filter:blur(18px) saturate(1.16);backdrop-filter:blur(18px) saturate(1.16);border:1px solid rgba(255,255,255,0.20);box-shadow:inset 0 1px 0 rgba(255,255,255,0.24), 0 18px 42px rgba(30,93,160,0.28);';
        } else {
          wBgStyle = _G('panel');
        }
        var wGlassSheen = (themeSurface === 'flat' || themeSurface === 'neon') ? '' : '<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.18),transparent 42%,rgba(0,0,0,0.08));pointer-events:none;"></div>';
        var wInsetBorder = 'inset 0 0 0 1px ' + (themeSurface === 'neon' ? 'rgba(5,8,5,0.10)' : 'rgba(255,255,255,0.08)');
        return '<div style="width:100%;min-height:160px;height:100%;border-radius:var(--card-radius,' + _R('widget') + ');' +
          wBgStyle +
          'padding:20px 24px 18px;box-sizing:border-box;color:var(--text-primary,#fff);' +
          'display:grid;grid-template-columns:1fr auto;grid-template-rows:auto 1fr auto;overflow:hidden;position:relative;font-family:var(--font);">' +
          wGlassSheen +
          '<div style="position:absolute;inset:1px;border-radius:calc(var(--card-radius,' + _R('widget') + ') - 1px);box-shadow:' + wInsetBorder + ';pointer-events:none;"></div>' +
          '<div style="position:relative;z-index:1;grid-column:1;grid-row:1;display:flex;flex-direction:column;align-items:flex-start;">' +
            '<div style="font-size:var(--card-weather-temp-size,32px);font-weight:var(--card-weather-temp-weight,700);line-height:0.95;letter-spacing:var(--card-weather-temp-letterspacing,-1px);color:var(--card-weather-temp-color,var(--text-primary,#fff));">' + wTemp + '</div>' +
            (wLocation ? '<div style="margin-top:7px;font-size:12px;font-weight:600;line-height:1;color:var(--text-secondary,rgba(255,255,255,0.86));display:flex;align-items:center;gap:4px;"><span style="font-size:11px;">⊙</span><span>' + wLocation + '</span></div>' : '') +
          '</div>' +
          '<div style="position:relative;z-index:1;grid-column:2;grid-row:1;justify-self:end;width:58px;height:48px;filter:drop-shadow(0 3px 4px rgba(0,0,0,0.18));">' +
            '<div style="width:100%;height:100%;">' + wIcon + '</div>' +
          '</div>' +
          '<div style="position:relative;z-index:1;grid-column:1;grid-row:3;align-self:end;display:flex;flex-direction:column;gap:4px;min-width:0;">' +
            (wCondition ? '<div style="font-size:12px;font-weight:600;line-height:1.1;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + wCondition + '</div>' : '') +
            '<div style="font-size:11px;font-weight:600;line-height:1;color:var(--text-secondary,rgba(255,255,255,0.78));white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + (wFeels ? 'Feels ' + wFeels : wWind) + '</div>' +
          '</div>' +
          '<div style="position:relative;z-index:1;grid-column:2;grid-row:3;align-self:end;justify-self:end;text-align:right;display:flex;flex-direction:column;gap:4px;">' +
            '<div style="font-size:13px;font-weight:700;line-height:1;color:var(--text-secondary,rgba(255,255,255,0.90));white-space:nowrap;">' + wDate + '</div>' +
            '<div style="font-size:46px;font-weight:700;line-height:0.86;letter-spacing:-1.6px;color:var(--text-primary,#fff);">' + wTime + '</div>' +
          '</div>' +
          '<div style="position:absolute;left:24px;right:24px;bottom:12px;height:1px;background:color-mix(in srgb, var(--text-primary,#fff) 18%, transparent);transform:translateY(7px);"></div>' +
        '</div>';
      }

      if (fv.kind === 'hero') {
        return '<div style="width:100%;height:100%;border-radius:' + _R('widget') + ';' +
          _G('panel') +
          'display:flex;align-items:center;justify-content:center;box-sizing:border-box;overflow:hidden;">' +
          '<div style="width:60px;height:60px;border-radius:50%;background:' + faccent + ';opacity:0.6;"></div>' +
        '</div>';
      }
      // 'secondary' editorial card: title + body paragraph, no dot.
      // Used for Detail-screen focus-block stacks where every card should
      // read as a short article block (title + 1-2 line copy).
      if (fv.kind === 'secondary') {
        return '<div style="width:100%;height:100%;border-radius:' + _R('widget') + ';' +
          _G('panel') +
          'padding:20px 22px;box-sizing:border-box;display:flex;flex-direction:column;justify-content:center;gap:10px;overflow:hidden;">' +
          '<div style="' + _T('large', { weight: 'bold' }) + 'line-height:1.2;">' + ftitle + '</div>' +
          (fbody ? '<div style="' + _T('label', { color: 'translucentLabel' }) +
            'line-height:1.4;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden;">' + fbody + '</div>' : '') +
        '</div>';
      }
      // Widget-style cell (focus-block-group expansion)
      if (fv.kind) {
        return '<div style="width:100%;height:100%;border-radius:' + _R('widget') + ';' +
          _G('panel') +
          'padding:' + _S('lg') + ';box-sizing:border-box;display:flex;flex-direction:column;justify-content:space-between;gap:' + _S('sm') + ';overflow:hidden;">' +
          '<div style="display:flex;justify-content:space-between;align-items:flex-start;">' +
            '<div style="' + _T('micro', { color: 'translucentLabel' }) + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + ftitle + '</div>' +
            '<div style="width:8px;height:8px;border-radius:50%;background:' + faccent + ';flex-shrink:0;"></div>' +
          '</div>' +
          (fvalue ? '<div style="' + _T('large', { weight: 'bold' }) + 'line-height:1;">' + fvalue + '</div>' : '') +
          (fsub ? '<div style="' + _T('micro', { color: 'sectionLabel' }) + 'white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + fsub + '</div>' : '') +
        '</div>';
      }
      // Default focus-block
      return '<div style="width:100%;height:100%;border-radius:' + _R('widget') + ';' +
        _G('panel') +
        'padding:' + _S('3xl') + ';box-sizing:border-box;">' +
        '<div style="' + _T('large', { weight: 'bold' }) + '">' + ftitle + '</div>' +
        (fsub ? '<div style="' + _T('label', { color: 'translucentLabel' }) + 'margin-top:' + _S('sm') + ';">' + fsub + '</div>' : '') +
      '</div>';
    }

    case 'list-item': {
      // Mirrors the `notif-card` atomic (Figma Notification/Regular 544:1088)
      // with two theme variants:
      //   theme='light' (default) → bg #ffffff, text #000 — List screen
      //   theme='dark'            → bg rgba(23,23,26,0.6), text #efeef2 —
      //     used in Detail screen where the group sits in a glass shell
      //
      // Shared layout: rounded 50 pill, 56 icon, title+time row, subtitle
      // below, trailing chevron or badge pill.
      var lv = (comp && comp.variant) || {};
      var liSurfRoot = _themeSurfaceStyleRoot();
      var liTheme  = lv.theme === 'dark' ? 'dark' : 'light';
      var title    = lv.title    || 'Item';
      var subtitle = lv.subtitle || '';
      var time     = lv.time     || '';
      var avatar   = lv.avatar   || null;
      var glyph    = lv.glyph    || title.charAt(0).toUpperCase();
      var accent   = lv.accent   || '#4285F4';
      var badge    = lv.badge;

      var liBg, liTitleColor, liTimeColor, liSubColor, liChevColor;
      if (liTheme === 'dark') {
        liBg         = 'rgba(23,23,26,0.6)';
        liTitleColor = '#efeef2';
        liTimeColor  = '#d5d5d5';
        liSubColor   = '#cfcccf';
        liChevColor  = '#ffffff';
      } else if (liSurfRoot === 'neon') {
        liBg         = 'var(--surface-bg, #b8ff42)';
        liTitleColor = 'var(--text-primary,#050805)';
        liTimeColor  = 'var(--text-secondary,rgba(5,8,5,0.72))';
        liSubColor   = 'var(--text-secondary,rgba(5,8,5,0.72))';
        liChevColor  = 'var(--text-primary,#050805)';
      } else {
        liBg         = '#ffffff';
        liTitleColor = '#000000';
        liTimeColor  = '#555555';
        liSubColor   = '#333333';
        liChevColor  = '#222222';
      }

      var iconHTML = avatar
        ? '<img src="app-icons/' + avatar + '" style="width:56px;height:56px;border-radius:50%;object-fit:cover;flex-shrink:0;"/>'
        : '<div style="width:56px;height:56px;border-radius:50%;background:' + accent +
            ';display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
            'color:#fff;font-size:22px;font-weight:600;line-height:1;">' + glyph + '</div>';

      var trailingHTML = (badge != null && badge > 0)
        ? '<div style="min-width:18px;height:18px;padding:0 5px;border-radius:9px;background:#FF3B30;' +
            'display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;' +
            'font-size:10px;font-weight:700;font-family:Inter,system-ui,sans-serif;">' + badge + '</div>'
        : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;opacity:0.8;"><path d="M6 9l6 6 6-6" stroke="' + liChevColor + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>';

      var liNeonChrome = liSurfRoot === 'neon' && liTheme !== 'dark'
        ? 'border:var(--surface-border);box-shadow:var(--surface-shadow);'
        : '';

      return '<div style="width:100%;height:100%;background:' + liBg +
        ';border-radius:var(--card-radius,' + _R('widget') + ');' + liNeonChrome +
        'padding:15px 20px 15px 16px;box-sizing:border-box;' +
        'display:flex;align-items:center;gap:10px;overflow:hidden;font-family:var(--font);">' +
        iconHTML +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">' +
          '<div style="display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden;">' +
            '<span style="font-size:15px;font-weight:600;color:' + liTitleColor + ';overflow:hidden;text-overflow:ellipsis;">' + title + '</span>' +
            (time ? '<span style="font-size:12px;font-weight:400;color:' + liTimeColor + ';flex-shrink:0;">' + time + '</span>' : '') +
          '</div>' +
          (subtitle
            ? '<div style="font-size:14px;font-weight:400;color:' + liSubColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">' + subtitle + '</div>'
            : '') +
        '</div>' +
        trailingHTML +
      '</div>';
    }

    case 'paragraph': {
      var pv = (comp && comp.variant) || {};
      var ptxt = pv.text || '';
      if (pv.kind === 'title') {
        return '<div style="width:100%;height:100%;display:flex;align-items:center;">' +
          '<div style="' + _T('headline', { weight: 'bold' }) + 'line-height:1.2;">' + ptxt + '</div>' +
        '</div>';
      }
      return '<div style="width:100%;height:100%;display:flex;align-items:flex-start;">' +
        '<div style="' + _T('body', { color: 'translucentLabel' }) + 'line-height:1.5;">' + ptxt + '</div>' +
      '</div>';
    }

    case 'action-row': {
      // Reads an action list from whichever channel the AI populated:
      //   variant.actions = [{label, icon?}, …]  ← primary contract (role
      //                                              contract says this)
      //   content.actions = [{label, icon?}, …]  ← content-channel alias
      //   variant.primary / variant.secondary    ← legacy 2-button form
      //
      // Earlier revision hardcoded "Primary" / "Secondary" as fallback
      // labels, which is exactly the "placeholder strings" anti-pattern
      // we ban in sanitize — it leaked dummy-looking buttons onto any
      // screen where the AI emitted an action-row without labels. Now:
      // if we have no real labels, render NOTHING (empty div). The
      // sanitize pass drops action-rows with no actions so this path
      // shouldn't fire in production, but kept as a last-resort guard.
      var av = (comp && comp.variant) || {};
      var ac = (comp && comp.content) || {};
      var actions = Array.isArray(av.actions) ? av.actions
                  : Array.isArray(ac.actions) ? ac.actions
                  : null;
      if (!actions) {
        // Legacy 2-button form — only honor when actual strings supplied,
        // never the "Primary"/"Secondary" placeholders.
        var hasLegacy = (av.primary && av.primary !== 'Primary') ||
                        (av.secondary && av.secondary !== 'Secondary');
        if (hasLegacy) {
          actions = [];
          if (av.primary)   actions.push({ label: av.primary,   kind: 'primary'   });
          if (av.secondary) actions.push({ label: av.secondary, kind: 'secondary' });
        }
      }
      if (!actions || !actions.length) {
        return '<div style="width:100%;height:100%;"></div>';
      }
      function _escActionLbl(s) {
        return String(s == null ? '' : s)
          .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
      }
      // Inline glyph set for action chips. Compact 16×16 icons — currentColor.
      var ACTION_ICONS = {
        bookmark:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 4v17l6-4 6 4V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        share:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="6" cy="12" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="18" r="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M8.2 11l7.6-4M8.2 13l7.6 4" stroke="currentColor" stroke-width="1.8"/></svg>',
        edit:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M16 3l5 5-12 12H4v-5L16 3z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        trash:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 7h14M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        copy:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><rect x="8" y="4" width="12" height="14" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M16 18v2a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        download:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 4v12M6 12l6 6 6-6M4 20h16" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        heart:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 21l-9-9a5 5 0 0 1 7-7l2 2 2-2a5 5 0 0 1 7 7l-9 9z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        comment:     '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M21 12a8 8 0 0 1-12 7L3 21l1.5-5A8 8 0 1 1 21 12z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        play:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M7 5l12 7-12 7V5z"/></svg>',
        pause:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><rect x="7" y="5" width="3.5" height="14"/><rect x="13.5" y="5" width="3.5" height="14"/></svg>',
        'skip-forward':'<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M5 5l9 7-9 7V5z"/><rect x="16" y="5" width="2.5" height="14"/></svg>',
        'skip-back': '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M19 5L10 12l9 7V5z"/><rect x="5.5" y="5" width="2.5" height="14"/></svg>',
        plus:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        x:           '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        check:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M5 13l4 4L19 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        settings:    '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="3" stroke="currentColor" stroke-width="1.8"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M4.93 4.93l2.12 2.12M16.95 16.95l2.12 2.12M4.93 19.07l2.12-2.12M16.95 7.05l2.12-2.12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        search:      '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="1.8"/><path d="M16.5 16.5L21 21" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        clock:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v5l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        swap:        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M7 16V4M7 4l-3 3M7 4l3 3M17 8v12M17 20l3-3M17 20l-3-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        scale:       '<svg width="16" height="16" viewBox="0 0 24 24" fill="none"><path d="M12 3v18M8 7h8M8 17h8M6 21h12" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      };
      function _renderActionIcon(name) {
        return name && ACTION_ICONS[name]
          ? '<span style="display:inline-flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;">' + ACTION_ICONS[name] + '</span>'
          : '';
      }
      var actionRowSkin = _themeSurfaceStyleRoot();
      var actionRowNeon = actionRowSkin === 'neon';

      // Data-driven chip row — real `actions[]` from the pipeline. The old
      // Figma gallery mock is opt-in via `variant.previewGallery` (theme
      // customize / design demos only).
      if (!av.previewGallery) {
        var chipGap = _S('md');
        var chipPadH = _S('xl');
        var chipRad = 'var(--card-radius,' + _R('pill') + ')';
        var rowPad = _S('base');
        var chips = [];
        for (var ai = 0; ai < actions.length; ai++) {
          var act = actions[ai] || {};
          var albl = _escActionLbl(act.label || act.name || '');
          if (!albl) continue;
          var isPrimary = act.kind === 'primary' || (ai === 0 && act.kind !== 'secondary');
          var iconPart = _renderActionIcon(act.icon);
          var chipBase = 'display:inline-flex;align-items:center;justify-content:center;gap:' + _S('sm') + ';' +
            'min-height:44px;padding:0 ' + chipPadH + ';border-radius:' + chipRad + ';box-sizing:border-box;' +
            'font-family:var(--font);border:none;cursor:default;' +
            _T('label', { weight: 'medium' });
          var chipStyle = chipBase;
          if (isPrimary) {
            chipStyle = chipBase.replace(/color:[^;]+;/, '') +
              (actionRowSkin === 'gradient'
                ? 'background:#1A1A1B;color:#ffffff;border:none;'
                : 'background:var(--accent-primary,#0381FE);color:var(--accent-on-primary,#ffffff);border:none;');
          } else {
            chipStyle = chipBase.replace(/color:[^;]+;/, '') +
              'background:color-mix(in srgb, var(--surface-bg, rgba(23,23,26,0.5)) 55%, transparent);' +
              'color:var(--text-primary,#fff);border:var(--surface-border, 1px solid rgba(255,255,255,0.12));';
          }
          chips.push(
            '<span role="presentation" style="' + chipStyle + '">' +
              iconPart +
              '<span style="white-space:nowrap;line-height:1;">' + albl + '</span>' +
            '</span>'
          );
        }
        if (!chips.length) {
          return '<div style="width:100%;height:100%;"></div>';
        }
        return '<div style="width:100%;max-width:100%;box-sizing:border-box;display:flex;flex-wrap:wrap;' +
          'align-items:center;gap:' + chipGap + ';padding:' + rowPad + ';' + _G('panel') +
          'border-radius:var(--card-radius,' + _R('widget') + ');overflow:hidden;">' +
          chips.join('') +
        '</div>';
      }

      var PANEL_ICONS = {
        video: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="5" y="4" width="14" height="16" rx="3" stroke="currentColor" stroke-width="1.8"/><path d="M10 8l5 4-5 4V8z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        heart: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.5-7-10a4 4 0 0 1 7-2.5A4 4 0 0 1 19 10c0 5.5-7 10-7 10z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>',
        clock: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.8"/><path d="M12 8v5l3 2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        pin: '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><path d="M12 21s-6-6.2-6-11a6 6 0 1 1 12 0c0 4.8-6 11-6 11z" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="10" r="2.2" stroke="currentColor" stroke-width="1.8"/></svg>',
        users: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="9" cy="8" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="16" cy="9" r="2.5" stroke="currentColor" stroke-width="1.8"/><path d="M3.5 19c.8-3 3-4.5 5.5-4.5s4.7 1.5 5.5 4.5M13.5 16c1.9.2 3.4 1.2 4 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        clean: '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="5" y="9" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8"/><path d="M9 9V6a3 3 0 0 1 6 0v3M8 14h8M10 12v4M14 12v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>',
        trash: ACTION_ICONS.trash,
        settings: ACTION_ICONS.settings,
        chevron: '<svg width="30" height="30" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      };
      function shortcut(icon, label) {
        var scWrapFg = actionRowNeon ? 'var(--text-primary,#050805)' : 'rgba(239,238,242,0.54)';
        var scCircleBg = actionRowNeon ? '#ffffff' : 'rgba(10,10,12,0.86)';
        var scCircleFg = actionRowNeon ? 'var(--text-primary,#050805)' : 'rgba(239,238,242,0.56)';
        var scCircleBorder = actionRowNeon ? '1px solid rgba(5,8,5,0.12)' : 'none';
        return '<div style="display:flex;flex-direction:column;align-items:center;gap:12px;min-width:0;color:' + scWrapFg + ';">' +
          '<div style="width:54px;height:54px;border-radius:50%;background:' + scCircleBg + ';border:' + scCircleBorder + ';display:flex;align-items:center;justify-content:center;color:' + scCircleFg + ';">' + PANEL_ICONS[icon] + '</div>' +
          '<div style="font-size:15px;font-weight:500;line-height:1;white-space:nowrap;">' + label + '</div>' +
        '</div>';
      }
      function panelPill(icon, label, dot) {
        var pillBg = actionRowNeon ? '#ffffff' : 'rgba(10,10,12,0.86)';
        var pillFg = actionRowNeon ? 'var(--text-primary,#050805)' : 'rgba(239,238,242,0.58)';
        var pillBorder = actionRowNeon ? '1px solid rgba(5,8,5,0.12)' : 'none';
        return '<div style="height:44px;border-radius:28px;background:' + pillBg + ';border:' + pillBorder + ';display:flex;align-items:center;justify-content:center;gap:12px;color:' + pillFg + ';font-size:15px;font-weight:500;line-height:1;position:relative;">' +
          '<span style="width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;flex:none;">' + PANEL_ICONS[icon] + '</span>' +
          '<span style="display:inline-flex;align-items:center;justify-content:center;line-height:1;white-space:nowrap;">' + label + '</span>' +
          (dot ? '<span style="position:absolute;right:36px;top:50%;transform:translateY(-11px);width:6px;height:6px;border-radius:50%;background:#E65B17;"></span>' : '') +
        '</div>';
      }
      var studioBarBg = actionRowNeon ? '#ffffff' : 'rgba(10,10,12,0.86)';
      var studioBarFg = actionRowNeon ? 'var(--text-primary,#050805)' : 'rgba(239,238,242,0.70)';
      var studioBarChev = actionRowNeon ? 'var(--text-primary,#050805)' : 'rgba(239,238,242,0.72)';
      var studioBarBorder = actionRowNeon ? '1px solid rgba(5,8,5,0.12)' : 'none';
      var studioTileBg = actionRowNeon ? 'rgba(5,8,5,0.10)' : '#e6e6e6';
      return '<div style="width:100%;max-width:100%;min-height:0;display:flex;flex-direction:column;align-items:center;padding:24px;gap:20px;box-sizing:border-box;' + _G('panel') +
        'border-radius:var(--card-radius,28px);color:var(--text-primary,#fff);font-family:var(--font);overflow:hidden;">' +
        '<div style="width:100%;display:grid;grid-template-columns:repeat(4,1fr);gap:18px;">' +
          shortcut('video', 'Videos') + shortcut('heart', 'Favorites') + shortcut('clock', 'Recent') + shortcut('pin', 'Locations') +
        '</div>' +
        '<div style="width:100%;display:grid;grid-template-columns:1fr 1fr;gap:20px;">' +
          panelPill('users', 'Shared albums') + panelPill('clean', 'Clean out', true) +
          panelPill('trash', 'Trash') + panelPill('settings', 'Settings') +
        '</div>' +
        '<div style="width:100%;height:64px;border-radius:32px;background:' + studioBarBg + ';border:' + studioBarBorder + ';display:flex;align-items:center;gap:20px;padding:0 28px 0 20px;box-sizing:border-box;color:' + studioBarFg + ';font-size:20px;font-weight:500;">' +
          '<span style="width:24px;height:24px;border-radius:8px;background:' + studioTileBg + ';flex:none;"></span>' +
          '<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">Go to Studio</span>' +
          '<span style="display:flex;color:' + studioBarChev + ';">' + PANEL_ICONS.chevron + '</span>' +
        '</div>' +
      '</div>';
    }

    case 'focus-block-group':
      return '<div style="width:100%;height:100%;display:grid;grid-template-columns:1fr 1fr;gap:' + _S('lg') + ';">' +
        '<div style="border-radius:' + _R('widget') + ';' + _G('widgetPill') + '"></div>' +
        '<div style="border-radius:' + _R('widget') + ';' + _G('widgetPill') + '"></div>' +
        '<div style="border-radius:' + _R('widget') + ';' + _G('widgetPill') + '"></div>' +
        '<div style="border-radius:' + _R('widget') + ';' + _G('widgetPill') + '"></div>' +
      '</div>';

    case 'list':
    case 'notification-list':
      // Plain list — 6 simple system-surface rows (used when the list
      // isn't expanded into individual list-item children).
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;gap:' + _S('base') + ';">' +
        Array.from({ length: 6 }).map(() =>
          '<div style="height:56px;border-radius:' + _R('widget') + ';background:#F1F1F3;box-shadow:0 1px 2px rgba(0,0,0,0.08);"></div>'
        ).join('') +
      '</div>';

    case 'detail-content': {
      // Detail screen — "related items" rows use the DARK notif-card
      // variant at rgba(23,23,26,0.6) (30% opacity) and the outer shell
      // also uses rgba(23,23,26,0.6) so the whole section reads as one
      // cohesive dark glass group over the wallpaper/app background.
      var presetItems = [
        { title: 'Lisa Park',    sub: 'Shared a photo · 2 new',  time: '10:32 AM', glyph: 'L', accent: '#E91E63', theme: 'dark' },
        { title: 'Team standup', sub: 'Starts in 15 min · Zoom', time: '9:45 AM',  glyph: 'T', accent: '#4285F4', theme: 'dark' },
        { title: 'Gmail',        sub: 'Re: Q2 planning draft',   time: '8:14 AM',  glyph: 'M', accent: '#EA4335', theme: 'dark' },
        { title: 'Bank',         sub: '\u2212$48.20 at Starbucks', time: '7:02 AM', glyph: '$', accent: '#00A86B', theme: 'dark' }
      ];
      var cardsHTML = presetItems.map(function (it) {
        return '<div style="height:86px;">' +
          window.renderAtomicForRole(
            { role: 'list-item', variant: it },
            { w: 0, h: 86 }
          ) +
        '</div>';
      }).join('');
      return '<div style="width:100%;height:100%;' +
        'background:rgba(23,23,26,0.6);' +
        '-webkit-backdrop-filter:blur(16px);backdrop-filter:blur(16px);' +
        'border:1px solid rgba(255,255,255,0.08);border-radius:32px;' +
        'padding:10px;box-sizing:border-box;overflow:hidden;' +
        'display:flex;flex-direction:column;gap:6px;">' +
        cardsHTML +
      '</div>';
    }

    case 'bottom-navigation': {
      var bnc = (comp && comp.content) || {};
      var tabs = Array.isArray(bnc.tabs) ? bnc.tabs : ['Home','Explore','Saved','Profile'];
      var activeIdx = bnc.activeIndex != null ? bnc.activeIndex : 0;

      // Returns a SVG path pair: { outline, filled } for active/inactive state.
      // Samsung One UI bottom-nav: filled variant on active, outline on rest.
      function navIconFor(name, active) {
        var lc = (name || '').toLowerCase();
        var c = 'currentColor';
        var sw = active ? '0' : '1.7';
        var fill = active ? c : 'none';
        var s = 'width="22" height="22" viewBox="0 0 24 24"';

        if (/home|main|for.you/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><path d="M3 11L12 3l9 8v9a1 1 0 0 1-1 1h-5v-7h-6v7H4a1 1 0 0 1-1-1v-9z" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round"/></svg>';
        }
        if (/search|explore|discover|browse|find/.test(lc)) {
          return '<svg ' + s + ' fill="none"><circle cx="11" cy="11" r="7" stroke="' + c + '" stroke-width="' + (active ? '2.2' : '1.7') + '" fill="' + (active ? c : 'none') + '" fill-opacity="' + (active ? '0.18' : '0') + '"/><path d="M20 20l-3.5-3.5" stroke="' + c + '" stroke-width="' + (active ? '2.4' : '1.7') + '" stroke-linecap="round"/></svg>';
        }
        if (/save|bookmark|wishlist|favorite|favour|like|heart/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round"/></svg>';
        }
        if (/profile|account|me|user/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><circle cx="12" cy="8" r="3.5" stroke="' + c + '" stroke-width="' + sw + '"/><path d="M5 20a7 7 0 0 1 14 0" stroke="' + c + '" stroke-width="' + sw + '" stroke-linecap="round" fill="' + fill + '"/></svg>';
        }
        if (/message|chat|inbox|mail/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><path d="M4 6h16v10H8l-4 4V6z" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round"/></svg>';
        }
        if (/cart|shop|buy/.test(lc)) {
          return '<svg ' + s + ' fill="none"><path d="M4 5h2l2 12h11l2-8H7" stroke="' + c + '" stroke-width="' + (active ? '2.2' : '1.7') + '" stroke-linejoin="round" fill="' + (active ? c : 'none') + '" fill-opacity="' + (active ? '0.18' : '0') + '"/><circle cx="10" cy="20" r="1.6" fill="' + c + '"/><circle cx="17" cy="20" r="1.6" fill="' + c + '"/></svg>';
        }
        if (/album|gallery|photo|media|library/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><rect x="4" y="5" width="16" height="14" rx="2" stroke="' + c + '" stroke-width="' + sw + '"/><circle cx="9" cy="10" r="1.5" stroke="' + c + '" fill="' + (active ? '#fff' : 'none') + '" stroke-width="' + sw + '"/><path d="M4 16l5-5 4 4 3-3 4 4" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round" fill="none"/></svg>';
        }
        if (/play|music|listen/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><path d="M8 5l12 7-12 7V5z" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round"/></svg>';
        }
        if (/notif|alert|bell/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><path d="M6 16V11a6 6 0 0 1 12 0v5l1.5 2H4.5L6 16z" stroke="' + c + '" stroke-width="' + sw + '" stroke-linejoin="round"/><path d="M10 20a2 2 0 0 0 4 0" stroke="' + c + '" stroke-width="1.7" stroke-linecap="round" fill="none"/></svg>';
        }
        if (/settings|gear|pref/.test(lc)) {
          return '<svg ' + s + ' fill="' + fill + '"><circle cx="12" cy="12" r="3" stroke="' + c + '" stroke-width="' + sw + '"/><path d="M12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1" stroke="' + c + '" stroke-width="1.7" stroke-linecap="round"/></svg>';
        }
        if (/add|plus|create|new/.test(lc)) {
          return '<svg ' + s + ' fill="none"><circle cx="12" cy="12" r="9" stroke="' + c + '" stroke-width="' + (active ? '2.2' : '1.7') + '" fill="' + (active ? c : 'none') + '" fill-opacity="' + (active ? '0.18' : '0') + '"/><path d="M12 8v8M8 12h8" stroke="' + c + '" stroke-width="' + (active ? '2.2' : '1.7') + '" stroke-linecap="round"/></svg>';
        }
        // Fallback — solid dot when active, ring when inactive
        return '<svg ' + s + ' fill="' + fill + '"><circle cx="12" cy="12" r="5" stroke="' + c + '" stroke-width="' + sw + '"/></svg>';
      }

      var tabsHTML = tabs.slice(0, 5).map(function (t, i) {
        var active = i === activeIdx;
        var label = (t && typeof t === 'object') ? (t.label || t.text || '') : String(t);
        var styleLbl = active
          ? _T('micro', { weight: 'semibold' })
          : _T('micro', { color: 'sectionLabel' });
        return '<div style="display:flex;flex-direction:column;align-items:center;justify-content:center;gap:3px;flex:1;' +
          (active ? 'color:#fff;' : 'color:rgba(255,255,255,0.55);') +
        '">' +
          '<div style="display:flex;align-items:center;justify-content:center;line-height:0;">' + navIconFor(label, active) + '</div>' +
          '<span style="' + styleLbl + '">' + label + '</span>' +
        '</div>';
      }).join('');

      return '<div style="width:100%;height:100%;border-radius:var(--card-radius,' + _R('widget') + ');' +
        _G('widgetPill') +
        'display:flex;align-items:stretch;padding:6px 4px;box-sizing:border-box;">' +
        tabsHTML +
      '</div>';
    }

    case 'app-icon': {
      // Single app launcher: PNG icon + small label underneath.
      // Used inside Home's app-grid (expanded from `app-grid` role).
      var av = (comp && comp.variant) || {};
      var app = av.app || 'App';
      var pngMap = {
        'Phone':'Phone.png','Messages':'Messages.png','Internet':'Internet.png',
        'Camera':'Camera.png','Gallery':'Gallery.png','Contacts':'Contacts.png',
        'Settings':'Settings.png','Clock':'Clock.png','Weather':'Weather.png',
        'Calculator':'Calculator.png','Calendar':'Clock.png','Notes':'Notes.png',
        'Cloud':'Cloud.png','Health':'Health.png','Reminder':'Reminder.png',
        'Store':'Store.png','SmartThings':'SmartThings.png','Bixby':'Bixby.png',
        'MyFiles':'MyFiles.png','Studio':'Studio.png','Wallet':'Wallet.png',
        'Wearable':'Wearable.png','Pass':'Pass.png','Find':'Find.png',
        'Radio':'Radio.png','VoiceRecorder':'VoiceRecorder.png',
        'DailyBoard':'DailyBoard.png','DeviceCare':'DeviceCare.png',
        'DigitalWellbeing':'DigitalWellbeing.png','SecureFolder':'SecureFolder.png',
        'SecureWifi':'SecureWifi.png'
      };
      var file = pngMap[app];
      // Size icon to the cell width (leave room for 22px label)
      var iconSize = rect ? Math.min(rect.w - 8, (rect.h || 0) - 22, 72) : 60;
      if (iconSize < 32) iconSize = 32;
      var iconRadius = Math.round(iconSize * 0.28);

      var iconHTML;
      if (file) {
        iconHTML = '<img src="app-icons/' + file + '" style="width:' + iconSize + 'px;height:' + iconSize + 'px;border-radius:' + iconRadius + 'px;object-fit:cover;flex-shrink:0;">';
      } else {
        iconHTML = '<div style="width:' + iconSize + 'px;height:' + iconSize + 'px;border-radius:' + iconRadius + 'px;background:var(--accent-primary,#4285F4);display:flex;align-items:center;justify-content:center;flex-shrink:0;color:#fff;line-height:1;' +
          _T('heading', { weight: 'bold', color: '#fff' }) + '">' + app.charAt(0).toUpperCase() + '</div>';
      }

      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;">' +
        iconHTML +
        '<div style="font-size:10px;font-weight:500;color:var(--text-primary,#fff);line-height:1.35;text-align:center;max-width:100%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;padding:0 2px 1px;">' + app + '</div>' +
      '</div>';
    }

    // ─── OneUI 8.5 atomics — extracted from Figma One UI Design Kit ───────
    // Shared primitives intentionally kept small so Media / QS / Notif
    // variants can be composed from them.

    case 'toggle-chip': {
      // Multi-toggle ROW path — emitted by the `quick_toggle_row`
      // adapter. Lays out N circular toggles side-by-side with a tiny
      // label under each. Used for Samsung QS-style strips on lock or
      // home surface.
      var tcvRow = (comp && comp.variant) || {};
      if (Array.isArray(tcvRow.toggles) && tcvRow.toggles.length) {
        if (A && typeof A.QSToggleStrip === 'function') {
          return A.QSToggleStrip({ toggles: tcvRow.toggles });
        }
        var TOGGLE_ROW_ICONS = {
          'wifi':       '<path d="M2 9c5-4 15-4 20 0M5 13c3.5-3 11-3 14 0M9 17c1.7-1.3 4.3-1.3 6 0M12 21h0.01" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
          'bluetooth':  '<path d="M7 17l10-10-5-5v20l5-5-10-10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
          'flashlight': '<path d="M9 3h6v3l-1 3H10L9 6V3zM10 9h4v12h-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
          'airplane':   '<path d="M3 13l8-2V5a1 1 0 0 1 2 0v6l8 2v2l-8-1v4l2 1v2l-3-1-3 1v-2l2-1v-4l-8 1v-2z" fill="currentColor"/>',
          'hotspot':    '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 16a6 6 0 0 1 0-8M16 16a6 6 0 0 0 0-8M5 19a10 10 0 0 1 0-14M19 19a10 10 0 0 0 0-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
          'location':   '<path d="M12 22s-7-7-7-12a7 7 0 1 1 14 0c0 5-7 12-7 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
          'auto-rotate':'<path d="M4 12a8 8 0 0 1 14-5l2-2M20 7v4h-4M20 12a8 8 0 0 1-14 5l-2 2M4 17v-4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
          'sound':      '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
          'vibrate':    '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M18 8c1.5 1 2 2.5 2 4s-0.5 3-2 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
          'mute':       '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round" fill="none"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>',
          'power-save': '<rect x="5" y="7" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="19" y="10" width="2" height="4" fill="currentColor"/><path d="M11 10l-2 4h3l-1 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
          'camera':     '<rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="13.5" r="3.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 7l1.5-2h3L15 7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round" fill="none"/>',
          'screen-share':'<rect x="3" y="5" width="18" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>'
        };
        var tiles = tcvRow.toggles.map(function (t) {
          var iconPath = TOGGLE_ROW_ICONS[t.icon] || TOGGLE_ROW_ICONS['sound'];
          var bg    = t.on
            ? 'var(--qs-row-toggle-on-bg, rgba(246,248,248,0.88))'
            : 'var(--qs-row-toggle-off-bg, rgba(56,77,82,0.42))';
          var color = t.on
            ? 'var(--qs-row-toggle-on-fg, rgba(30,42,46,0.82))'
            : 'var(--qs-row-toggle-off-fg, rgba(214,226,226,0.52))';
          var shadow = t.on
            ? 'box-shadow:inset 0 1px 0 rgba(255,255,255,0.65),0 8px 18px rgba(0,0,0,0.18);'
            : 'box-shadow:inset 0 1px 0 rgba(255,255,255,0.08);';
          return '<div style="display:flex;align-items:center;justify-content:center;flex:1;min-width:0;cursor:pointer;" data-toggle-chip="1" data-on="' + (t.on ? '1' : '0') + '" title="' + t.name + '">' +
            '<div style="width:52px;height:52px;border-radius:50%;background:' + bg + ';display:flex;align-items:center;justify-content:center;color:' + color + ';transition:background 0.15s;' + shadow + '">' +
              '<svg width="23" height="23" viewBox="0 0 24 24">' + iconPath + '</svg>' +
            '</div>' +
          '</div>';
        }).join('');
        return '<div style="width:100%;min-height:92px;height:100%;display:flex;align-items:center;justify-content:space-around;gap:12px;padding:18px 20px;box-sizing:border-box;border-radius:var(--card-radius,' + _R('widget') + ');' +
          _G('panel') +
          'overflow:hidden;position:relative;">' +
          '<div style="position:absolute;inset:0;background:linear-gradient(180deg,rgba(255,255,255,0.10),transparent 58%,rgba(0,0,0,0.08));pointer-events:none;opacity:var(--qs-row-sheen-opacity, 1);"></div>' +
          '<div style="position:relative;z-index:1;display:flex;align-items:center;justify-content:space-around;gap:12px;width:100%;">' +
          tiles +
          '</div>' +
          '<div style="position:absolute;left:50%;bottom:7px;transform:translateX(-50%);width:40px;height:4px;border-radius:4px;background:rgba(240,244,244,0.72);"></div>' +
        '</div>';
      }
      // 56×56 circular toggle — primitive. Matches Figma `ToggleIcon`
      // 544:1125 exactly: bg rgba(180,180,180,0.2) / p-13 / rounded-full.
      // `data-toggle-chip` marks it for the delegated interact-mode click
      // handler (see _bindInteractiveAtomics at bottom of file).
      //
      // variant.label → Samsung QS "label below circle" composition. NOT a
      //                 Figma-defined atomic — it's composed by Samsung from
      //                 Single/Toggle (88×88) + external label text. Use
      //                 `single-toggle` role (role = 'single-toggle') for
      //                 Figma-exact 88×88 wrapper or 199×88 side-label.
      // variant.icon  → named glyph for the circle center.
      var tcv = (comp && comp.variant) || {};
      var on = tcv.on === true || tcv.state === 'on';
      var label = tcv.label || '';
      var iconKey = tcv.icon || '';

      // Small icon library for QS labeled toggles. Keys mirror the Samsung
      // QS names (auto-rotate / airplane / flashlight / …). Unknown keys
      // fall back to a neutral + / ✓ pair.
      var ICONS = {
        'sound':       '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        'vibrate':     '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M18 8c1.5 1 2 2.5 2 4s-0.5 3-2 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        'mute':        '<path d="M5 9v6h4l5 4V5L9 9H5z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        // Figma 340:6297 — classic bluetooth B: diagonals + vertical spine.
        // Path: low-left → diag up-right → top-peak → vertical spine down →
        // low-right-peak → diag up-left back. Renders the recognizable
        // Samsung bluetooth glyph at 24×24.
        'bluetooth':   '<path d="M7 17l10-10-5-5v20l5-5-10-10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        'screen-share':'<rect x="3" y="5" width="18" height="11" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M9 20h6M12 16v4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        'camera':      '<rect x="3" y="7" width="18" height="13" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="13.5" r="3.5" stroke="currentColor" stroke-width="1.6"/><path d="M9 7l1.5-2h3L15 7" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        'auto-rotate': '<path d="M4 12a8 8 0 0 1 14-5l2-2M20 7v4h-4M20 12a8 8 0 0 1-14 5l-2 2M4 17v-4h4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        'airplane':    '<path d="M3 13l8-2V5a1 1 0 0 1 2 0v6l8 2v2l-8-1v4l2 1v2l-3-1-3 1v-2l2-1v-4l-8 1v-2z" fill="currentColor"/>',
        'flashlight':  '<path d="M9 3h6v3l-1 3H10L9 6V3zM10 9h4v12h-4z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        'hotspot':     '<path d="M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM8 16a6 6 0 0 1 0-8M16 16a6 6 0 0 0 0-8M5 19a10 10 0 0 1 0-14M19 19a10 10 0 0 0 0-14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        'power-save':  '<rect x="5" y="7" width="13" height="10" rx="1.5" stroke="currentColor" stroke-width="1.6"/><rect x="19" y="10" width="2" height="4" fill="currentColor"/><path d="M11 10l-2 4h3l-1 2" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>',
        'location':    '<path d="M12 22s-7-7-7-12a7 7 0 1 1 14 0c0 5-7 12-7 12z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/><circle cx="12" cy="10" r="2.5" stroke="currentColor" stroke-width="1.6"/>',
        'link':        '<path d="M10 14l-3 3a3 3 0 0 1-4-4l3-3M14 10l3-3a3 3 0 0 1 4 4l-3 3M8 16l8-8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        'quick-share': '<circle cx="6" cy="12" r="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="6" r="2.5" stroke="currentColor" stroke-width="1.6"/><circle cx="18" cy="18" r="2.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 11l8-4M8 13l8 4" stroke="currentColor" stroke-width="1.6"/>',
        'dex':         '<rect x="3" y="5" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M8 20h8M12 17v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><text x="12" y="12.5" font-size="6" fill="currentColor" text-anchor="middle" font-family="Arial" font-weight="700">DeX</text>',
        'eye-comfort': '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M16 8a6 6 0 1 1-4 10" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/><circle cx="10" cy="10" r="1" fill="currentColor"/>',
        'dnd':         '<circle cx="12" cy="12" r="9" stroke="currentColor" stroke-width="1.6"/><path d="M7 12h10" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        'qr':          '<rect x="4" y="4" width="6" height="6" stroke="currentColor" stroke-width="1.6"/><rect x="14" y="4" width="6" height="6" stroke="currentColor" stroke-width="1.6"/><rect x="4" y="14" width="6" height="6" stroke="currentColor" stroke-width="1.6"/><path d="M14 14h3v3M20 14v6M14 20h6" stroke="currentColor" stroke-width="1.6"/>',
        'interpreter': '<path d="M5 9h6M8 6v3M7 12l2 5 2-5M14 14l2 5 2-5M13 17h6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>',
        'multi':       '<path d="M6 12l4-4 4 4-4 4-4-4zM14 6h6v6M20 18h-6v-6" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>',
        'secure':      '<rect x="4" y="10" width="16" height="10" rx="2" stroke="currentColor" stroke-width="1.6"/><path d="M8 10V7a4 4 0 0 1 8 0v3M12 14v3" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
        'broadcast':   '<circle cx="12" cy="12" r="2" fill="currentColor"/><path d="M8 8a5 5 0 0 0 0 8M16 8a5 5 0 0 1 0 8M5 5a9 9 0 0 0 0 14M19 5a9 9 0 0 1 0 14" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>',
        // Figma "wifi 3" (3018:6371 / 6381) — 4 vectors: 3 nested arcs
        // (outer/middle/inner) bowing UP + 1 dot at the bottom center.
        // Cubic bezier used (instead of elliptical arc) for a smoother
        // Samsung curve at small sizes.
        'wifi':        '<path d="M5 10.5c3.9-3 10.1-3 14 0M7.5 13.5c2.6-2 6.4-2 9 0M10 16.5c1.3-1 2.7-1 4 0" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/><circle cx="12" cy="19" r="1.5" fill="currentColor"/>',
        // Figma 989:22477 / 3018:6357 "mobile data qs" — two vertical arrows
        // side-by-side: left ↓ (download), right ↑ (upload). Aspect ≈ 71:61.
        'mobile-data': '<path d="M8.5 4v16M4.5 15l4 5 4-5M15.5 20V4M11.5 9l4-5 4 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/>',
        // Figma 474:600 — battery "fully charged" pill with 100% fill.
        // Rounded rectangle body + small positive terminal nub on the right.
        'battery':     '<rect x="3" y="8" width="17" height="10" rx="2.5" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="20.5" y="11" width="1.5" height="4" rx="0.5" fill="currentColor"/><rect x="5" y="10" width="13" height="6" rx="1" fill="currentColor"/>',
        'modes':       '<circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 4v8l6 3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        // Figma brightness (I1109:10261;…;340:6324 + 6325) — sun disc + rays
        'brightness':  '<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v3M3 12h3M18 12h3M5.5 5.5l2 2M16.5 16.5l2 2M5.5 18.5l2-2M16.5 7.5l2-2" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        // Figma 1109:10246;…;530:6 — music eighth note with beam
        'music':       '<path d="M9 18V5l11-2v11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="7" cy="18" r="2.5" fill="currentColor"/><circle cx="18" cy="14" r="2.5" fill="currentColor"/>',
        // Figma 340:6583 — dark mode moon (crescent)
        'moon':        '<path d="M19 14A8 8 0 1 1 10 5a6 6 0 0 0 9 9z" fill="currentColor"/>',
        // Figma 340:7776 — sound vibrate (muted speaker with diagonal line)
        'mute':        '<path d="M4 10v4h3l4 3.5V6.5L7 10H4z" fill="currentColor"/><path d="M16 9l5 6M21 9l-5 6" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        // Phone handset — used by lock-screen bottom-left shortcut
        'phone':       '<path d="M5 4.5C5 3.67 5.67 3 6.5 3h2.28c0.69 0 1.28 0.47 1.44 1.14l0.59 2.35c0.11 0.43-0.02 0.88-0.33 1.19l-1.27 1.27a11.5 11.5 0 0 0 5.34 5.34l1.27-1.27c0.31-0.31 0.76-0.44 1.19-0.33l2.35 0.59c0.67 0.16 1.14 0.75 1.14 1.44V17.5c0 0.83-0.67 1.5-1.5 1.5C9.94 19 5 14.06 5 8.5V4.5z" fill="currentColor"/>'
      };
      var iconPath = ICONS[iconKey] || ICONS['modes'];
      var size = label ? 22 : 24;
      var iconColorOn = 'var(--qs-chip-icon-on, #222)';
      var iconColorOff = 'var(--qs-chip-icon-off, #fff)';
      var plusSvg = '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 5v14M5 12h14" stroke="' + iconColorOff + '" stroke-width="1.8" stroke-linecap="round"/></svg>';
      var iconSvg = '<svg width="' + size + '" height="' + size + '" viewBox="0 0 24 24" fill="none" style="color:' + (on ? iconColorOn : iconColorOff) + ';">' + iconPath + '</svg>';
      var circle = '<div data-toggle-chip data-on="' + (on ? '1' : '0') + '" ' +
        'style="width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;' +
          'background:' + (on ? 'var(--qs-chip-on-bg, #d5d5d5)' : 'var(--qs-chip-off-bg, rgba(180,180,180,0.2))') + ';transition:background 180ms ease;' +
          (label ? 'margin:0 auto 8px;' : 'margin:auto;') + '">' +
          '<span data-toggle-on style="display:' + (on ? 'inline-flex' : 'none') + ';">' + iconSvg + '</span>' +
          '<span data-toggle-off style="display:' + (on ? 'none' : 'inline-flex') + ';">' +
            (iconKey ? iconSvg.replace('color:' + iconColorOn, 'color:' + iconColorOff) : plusSvg) +
          '</span>' +
        '</div>';
      if (!label) return circle;
      // Labeled variant — ANCHOR the circle to the top (NOT justify-center)
      // so rows of chips stay perfectly aligned regardless of whether the
      // label wraps to 1 or 2 lines. Circle at padding-top:4; label at
      // fixed margin-top so it hangs below at a consistent offset.
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;' +
        'padding-top:4px;box-sizing:border-box;color:var(--text-primary,#fff);font-family:var(--font);overflow:visible;">' +
        circle +
        '<div style="font-size:11px;font-weight:500;text-align:center;line-height:1.25;max-width:86px;' +
          'margin-top:8px;white-space:normal;word-break:keep-all;color:var(--text-secondary,rgba(255,255,255,0.92));">' + label + '</div>' +
      '</div>';
    }

    case 'toggle-grid': {
      // Figma "Icons" shell — node 544:865 / 1109:10370. Glass pill with
      // N rows of 56×56 toggle-chips, evenly distributed via flex
      // justify-between. Spec matches 1:1:
      //   bg rgba(23,23,26,0.6) + 1px border rgba(255,255,255,0.2)
      //   rounded 50 · padding 24 25 · column flex gap 20
      //   per row: flex justify-between, 4 toggle-chips
      //   drag handle 50×4 bar near the bottom edge
      //
      // variant.cells → array of { icon, label, on } — when a cell has a
      //                 `label` we render the labeled toggle-chip (icon +
      //                 text below). No label = icon-only 56 circle.
      // variant.cols / rows → grid shape (default 4×2 = 8 cells).
      var tgv = (comp && comp.variant) || {};
      var cells = Array.isArray(tgv.cells) ? tgv.cells : null;
      var cols = tgv.cols || 4;
      var rows = tgv.rows || 2;

      function _tgCell(cellVariant) {
        return window.renderAtomicForRole(
          { role: 'toggle-chip', variant: cellVariant || {} },
          { w: 88, h: 88 }
        );
      }

      var rowsHtml = '';
      for (var r = 0; r < rows; r++) {
        var rowInner = '';
        for (var c = 0; c < cols; c++) {
          var idx = r * cols + c;
          var cellVariant;
          if (cells && cells[idx]) {
            cellVariant = {
              icon:  cells[idx].icon  || 'modes',
              label: cells[idx].label || '',
              on:    cells[idx].on === true
            };
          } else {
            cellVariant = { on: false };
          }
          rowInner += '<div style="flex-shrink:0;display:flex;align-items:center;justify-content:center;">' +
            _tgCell(cellVariant) +
          '</div>';
        }
        rowsHtml += '<div style="display:flex;align-items:flex-start;justify-content:space-between;width:100%;flex-shrink:0;">' +
          rowInner +
        '</div>';
      }

      return '<div style="width:100%;height:100%;' +
        _G('panel') +
        'border:var(--surface-border, 1px solid rgba(255,255,255,0.2));border-radius:var(--card-radius,' + _R('widget') + ');' +
        'padding:24px 25px;box-sizing:border-box;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:20px;' +
        'position:relative;overflow:hidden;">' +
        rowsHtml +
        // Figma drag handle (987:16943 + 544:2861): 11px holder at bottom:-1px
        // with a 50×4 bar riding at top of holder → visually sits just above
        // the bottom edge, bumping slightly past the rounded corner.
        '<div style="position:absolute;left:50%;bottom:-1px;transform:translateX(-50%);width:50px;height:11px;pointer-events:none;">' +
          '<div style="position:absolute;top:0;left:0;width:50px;height:4px;border-radius:2px;background:rgba(255,255,255,0.6);"></div>' +
        '</div>' +
      '</div>';
    }

    case 'slider-pill': {
      // Pill slider with gradient fill. Horizontal by default; set
      // `variant.orient = 'vertical'` for the tall brightness-style slider.
      // `variant.icon` selects the handle glyph:
      //   'volume' (default), 'sun' (brightness), 'moon' (night).
      var spv = (comp && comp.variant) || {};
      var pct = spv.percent != null ? spv.percent : 32;
      var orient = spv.orient || 'horizontal';
      var iconKey = spv.icon || 'volume';
      var ICON_SVGS = {
        'volume':    '<path d="M4 12h16M7 8l-3 4 3 4M17 8l3 4-3 4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        'sun':       '<circle cx="12" cy="12" r="4" stroke="currentColor" stroke-width="1.8"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5 5l1.5 1.5M17.5 17.5L19 19M5 19l1.5-1.5M17.5 6.5L19 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        'moon':      '<path d="M20 14a8 8 0 1 1-10-10 6 6 0 0 0 10 10z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/>',
        // Figma brightness (I1109:10261;…;340:6324 + 6325): sun disc + rays
        'brightness':'<circle cx="12" cy="12" r="4" fill="currentColor"/><path d="M12 2v3M12 19v2M3 12h2M19 12h2M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5l1.5-1.5M17 7l1.5-1.5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>',
        // Figma music (I1109:10246;…;530:6): eighth note with beam
        'music':     '<path d="M9 18V5l11-2v11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" fill="none"/><circle cx="7" cy="18" r="2.5" fill="currentColor"/><circle cx="18" cy="14" r="2.5" fill="currentColor"/>'
      };
      var iconSvg = ICON_SVGS[iconKey] || ICON_SVGS['volume'];

      if (orient === 'vertical') {
        // Tall vertical slider — fill grows from the BOTTOM up. Handle icon
        // sits at the bottom center of the pill (representing the control
        // handle / indicator glyph below the track).
        return '<div data-slider-pill data-pct="' + pct + '" data-orient="vertical" ' +
          'style="width:100%;height:100%;min-width:56px;background:rgba(185,185,185,0.2);border-radius:28px;position:relative;touch-action:none;overflow:hidden;">' +
          '<div data-slider-fill style="position:absolute;left:0;right:0;bottom:0;height:' + pct + '%;min-height:56px;background:linear-gradient(to top,#c6c4c3,#e4e4e4);border-radius:28px;transition:height 60ms linear;"></div>' +
          '<div style="position:absolute;bottom:13px;left:50%;transform:translateX(-50%);width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#222;pointer-events:none;">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' + iconSvg + '</svg>' +
          '</div>' +
        '</div>';
      }
      return '<div data-slider-pill data-pct="' + pct + '" ' +
        'style="width:100%;height:56px;background:rgba(185,185,185,0.2);border-radius:28px;position:relative;touch-action:none;">' +
        '<div data-slider-fill style="position:absolute;left:0;top:0;bottom:0;width:' + pct + '%;min-width:74px;background:linear-gradient(to right,#c6c4c3,#e4e4e4);border-radius:28px;transition:width 60ms linear;"></div>' +
        '<div style="position:absolute;left:13px;top:13px;width:30px;height:30px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#222;pointer-events:none;">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none">' + iconSvg + '</svg>' +
        '</div>' +
      '</div>';
    }

    case 'drag-handle': {
      // 50×4 rounded bar — bottom-of-sheet / QS expand indicator.
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;"><div style="width:50px;height:4px;border-radius:2px;background:rgba(255,255,255,0.6);"></div></div>';
    }

    case 'now-bar': {
      // Figma Now Bar — 248×64 pill with 3 type variants (3 distinct Figma
      // components sharing the same container spec):
      //   media    (752:7978) → teal bg rgba(3,78,110,0.8), 40 image + song
      //                          title (14 semibold) + prev/pause/next controls
      //   timer    (752:7988) → glass rgba(23,23,26,0.6) + 0.25 border, 40
      //                          icon (#5b53c8 optional bg) + 26 semibold time
      //                          + pause icon on right
      //   charging (752:7994) → glass + green Union gradient fill (left), bolt
      //                          icon + 26 semibold percent (no right icon)
      // All: backdrop-blur 12px, padding 12 top/bottom, pl 12 pr 18, radius 53.
      var nbv = (comp && comp.variant) || {};
      var nbType = nbv.type || 'timer';
      var common = 'min-height:64px;height:64px;-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);' +
        'padding:12px 18px 12px 12px;box-sizing:border-box;display:flex;align-items:center;gap:14px;' +
        'border-radius:53px;color:var(--text-primary,#fff);font-family:var(--font);overflow:hidden;position:relative;';

      if (nbType === 'media') {
        // Song title scrolls as a marquee. Earlier revisions used a
        // hardcoded "Never Gonna Give You Up · Rick Astley (1987)"
        // default that leaked into production screens when the AI
        // didn't supply a marquee (the "Astley (1987)" tail visible
        // on every music lockscreen generation). Now: if marquee isn't
        // set, build it from the actual content (title · artist · album),
        // falling back to just the title. Only use "Now playing" as a
        // last-ditch placeholder when literally nothing is emitted —
        // better than a wrong song name.
        var mSong    = nbv.title || nbv.song || 'Now playing';
        var mMarquee = nbv.marquee
          || [nbv.title || nbv.song, nbv.artist, nbv.album].filter(Boolean).join(' \u00B7 ')
          || mSong;
        var mImgBg   = nbv.imgBg || '#5b53c8';
        return '<div style="width:100%;' + common + _G('widgetPill') + 'padding:5px 12px;gap:8px;color:var(--text-primary,#fff);">' +
          '<div style="width:40px;height:40px;border-radius:37px;background:' + mImgBg + ';flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);">' +
            '<svg width="20" height="20" viewBox="0 0 24 24" fill="none"><path d="M9 18V5l12-2v13" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.8"/><circle cx="18" cy="16" r="3" stroke="currentColor" stroke-width="1.8"/></svg>' +
          '</div>' +
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;align-items:center;gap:10px;">' +
            // Marquee container: fixed 164 width, overflow-hidden, inner track animates
            '<div style="width:164px;height:14px;overflow:hidden;position:relative;mask-image:linear-gradient(to right,transparent 0,#000 8px,#000 calc(100% - 8px),transparent 100%);">' +
              '<div class="nowbar-marquee-track" style="position:absolute;top:0;left:0;white-space:nowrap;font-size:14px;font-weight:600;line-height:14px;color:var(--text-primary,#fff);animation:nowbar-marquee 14s linear infinite;">' +
                '<span style="padding-right:32px;">' + mMarquee + '</span>' +
                '<span style="padding-right:32px;">' + mMarquee + '</span>' +
              '</div>' +
            '</div>' +
            '<div style="display:flex;align-items:center;gap:15px;color:var(--text-primary,#fff);">' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M18 5L8 12l10 7V5z" fill="currentColor"/><rect x="5" y="5" width="2" height="14" fill="currentColor"/></svg>' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><rect x="7" y="5" width="3.5" height="14" fill="currentColor"/><rect x="13.5" y="5" width="3.5" height="14" fill="currentColor"/></svg>' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M6 5l10 7-10 7V5z" fill="currentColor"/><rect x="17" y="5" width="2" height="14" fill="currentColor"/></svg>' +
            '</div>' +
          '</div>' +
        '</div>';
      }

      // Navigation turn-by-turn — arrow icon (direction-aware) + big
      // distance + instruction text. Teal/blue accent for navigation
      // context. Mimics Samsung Maps live navigation now-bar.
      if (nbType === 'navigation') {
        var navDist  = nbv.distance    || '';
        var navInstr = nbv.instruction || 'Continue';
        var navEta   = nbv.eta         || '';
        var dir      = nbv.direction   || 'straight';
        // Direction-aware arrow glyphs
        var ARROW = {
          left:    '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M19 12H5M5 12l7-7M5 12l7 7" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          right:   '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M5 12h14M19 12l-7-7M19 12l-7 7" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          straight:'<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M12 19V5M12 5l-6 6M12 5l6 6" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          uturn:   '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M5 17V11a5 5 0 0 1 10 0v6M5 17l-2-3M5 17l3-3" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          exit:    '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M9 5l-4 7 4 7M5 12h12M14 7l4 5-4 5" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
          merge:   '<svg width="100%" height="100%" viewBox="0 0 24 24" fill="none"><path d="M12 19V8M12 8l-4 4M12 8l4 4M5 19l4-4M19 19l-4-4" stroke="var(--card-nav-accent,#14B8A6)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        };
        var arrow = ARROW[dir] || ARROW.straight;
        var nbSkin = _themeSurfaceStyleRoot();
        var navPillShell = nbSkin === 'neon'
          ? 'background:#ffffff;border:var(--surface-border);box-shadow:var(--surface-shadow);-webkit-backdrop-filter:none;backdrop-filter:none;'
          : _G('widgetPill');
        return '<div style="width:100%;' + common + navPillShell + 'gap:10px;">' +
          '<div style="width:40px;height:40px;border-radius:20px;background:var(--card-nav-arrow-bg,rgba(20,184,166,0.25));display:flex;align-items:center;justify-content:center;flex-shrink:0;padding:8px;">' +
            arrow +
          '</div>' +
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;overflow:visible;">' +
            (navDist
              ? '<div style="font-size:var(--card-nav-distance-size,22px);font-weight:600;line-height:1;color:var(--text-primary,#fff);letter-spacing:-0.4px;">' + navDist + '</div>'
              : '') +
            '<div style="font-size:8.5px;font-weight:500;color:var(--text-secondary,rgba(255,255,255,0.85));white-space:nowrap;overflow:visible;text-overflow:clip;letter-spacing:-0.45px;line-height:1.05;">' + navInstr + '</div>' +
          '</div>' +
          (navEta
            ? '<div style="font-size:8.5px;font-weight:500;color:var(--text-secondary,rgba(255,255,255,0.7));flex-shrink:0;padding-left:5px;border-left:1px solid color-mix(in srgb, var(--text-primary,#fff) 18%, transparent);">' + navEta + '</div>'
            : '') +
        '</div>';
      }

      // Dual-line — notification-style now-bar with a 40px app icon,
      // two stacked text lines, and an optional trailing status glyph.
      if (nbType === 'dual-line' || nbType === 'delivery') {
        var dlTitle    = nbv.title    || nbv.label   || '8min away';
        var dlSubtitle = nbv.subtitle || nbv.sub     || nbv.value || 'Arrives 9:45 - 9:50';
        var dlApp      = nbv.app      || nbv.service || nbv.iconLabel || 'Uber Eats';
        var dlIconBg   = nbv.iconBg   || '#35D466';
        var dlTrail    = nbv.trailing || nbv.trailingIcon || 'car';
        var dlTrailSvg = dlTrail === 'none' ? '' :
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex:none;opacity:0.78;">' +
            '<path d="M5 17h14M7 17l1.45-5h7.1L17 17M6 17v2M18 17v2" stroke="#848487" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>' +
            '<circle cx="9" cy="15.2" r="0.9" fill="#848487"/>' +
            '<circle cx="15" cy="15.2" r="0.9" fill="#848487"/>' +
          '</svg>';
        return '<div style="margin:0 auto;width:248px;height:64px;flex:none;flex-grow:0;' +
          'box-sizing:border-box;display:flex;flex-direction:row;align-items:center;padding:12px 18px 12px 12px;gap:14px;' +
          'background:var(--surface-bg, rgba(23,23,26,0.80));border:var(--surface-border, 1px solid rgba(255,255,255,0.12));' +
          '-webkit-backdrop-filter:var(--surface-filter, blur(12px));backdrop-filter:var(--surface-filter, blur(12px));border-radius:53px;' +
          'color:var(--text-primary,#fff);font-family:var(--font);overflow:hidden;">' +
          '<div style="width:40px;height:40px;border-radius:20px;background:' + dlIconBg + ';flex:none;display:flex;align-items:center;justify-content:center;color:#000;overflow:hidden;">' +
            '<div style="font-weight:800;font-size:13px;line-height:11px;letter-spacing:-0.7px;text-align:left;white-space:normal;">' + dlApp.replace(/\s+/, '<br>') + '</div>' +
          '</div>' +
          '<div style="flex:1 1 auto;min-width:0;display:flex;flex-direction:column;justify-content:center;gap:3px;">' +
            '<div style="font-size:17px;font-weight:700;line-height:18px;color:var(--text-primary,#fff);letter-spacing:-0.45px;white-space:nowrap;overflow:hidden;text-overflow:clip;">' + dlTitle + '</div>' +
            '<div style="font-size:13px;font-weight:400;line-height:15px;color:var(--text-secondary,rgba(255,255,255,0.92));letter-spacing:-0.25px;white-space:nowrap;overflow:hidden;text-overflow:clip;">' + dlSubtitle + '</div>' +
          '</div>' +
          dlTrailSvg +
        '</div>';
      }

      // Voice input — One UI voice/search pill.
      if (nbType === 'single-line') {
        var voicePrompt = nbv.prompt || nbv.placeholder || 'What are you looking for?';
        var voiceSurface = _themeSurfaceStyleRoot();
        var voiceIsFlat = voiceSurface === 'flat';
        var voiceIsNeon = voiceSurface === 'neon';
        var voiceIsGlass = voiceSurface === 'glass';
        var voiceBg = voiceIsNeon
          ? '#ffffff'
          : (voiceIsFlat
          ? 'var(--surface-bg, rgba(23,23,26,0.80))'
          : (voiceIsGlass
            ? 'radial-gradient(circle at 14% 0%,rgba(255,255,255,0.14) 0%,rgba(255,255,255,0.045) 30%,transparent 58%), linear-gradient(90deg,rgba(102,161,243,0.28) 0%,rgba(34,201,166,0.18) 58%,rgba(255,255,255,0.04) 100%), rgba(23,23,26,0.18)'
            : 'linear-gradient(90deg,#364B6F 0%,#384247 64.81%,#2D2D30 87.17%)'));
        var voiceNeonGreen = 'var(--surface-bg,#b8ff42)';
        var voiceTextStyle = voiceIsNeon
          ? 'color:' + voiceNeonGreen + ';'
          : (voiceIsFlat
            ? 'color:var(--accent-primary,#0381FE);'
            : 'background:linear-gradient(90deg,#78AFFF 0%,#31D8B3 100%);-webkit-background-clip:text;background-clip:text;color:transparent;');
        var voiceIconColor = voiceIsNeon
          ? voiceNeonGreen
          : (voiceIsFlat ? 'var(--accent-primary,#0381FE)' : '#31D8B3');
        var voiceChrome = voiceIsGlass
          ? 'border:1px solid rgba(255,255,255,0.16);-webkit-backdrop-filter:blur(42px) saturate(1.45) brightness(1.02);backdrop-filter:blur(42px) saturate(1.45) brightness(1.02);box-shadow:inset 0 1px 0 rgba(255,255,255,0.20), inset 0 -1px 0 rgba(255,255,255,0.035), 0 18px 42px rgba(0,0,0,0.24);'
          : (voiceIsNeon
            ? 'border:var(--surface-border, 1px solid rgba(255,255,255,0.12));-webkit-backdrop-filter:var(--surface-filter, blur(12px));backdrop-filter:var(--surface-filter, blur(12px));box-shadow:var(--surface-shadow, none);'
            : 'box-shadow:-1px 0px 4px 1px rgba(78,102,139,0.58);');
        return '<div style="margin:0 auto;width:381px;height:58px;display:flex;flex-direction:row;justify-content:space-between;align-items:center;padding:17px 20px;gap:12px;box-sizing:border-box;background:' + voiceBg + ';' + voiceChrome + 'border-radius:30px;color:var(--text-primary,#fff);font-family:var(--font);overflow:hidden;flex:none;flex-grow:0;">' +
          '<div style="font-size:17px;font-weight:700;line-height:1.05;letter-spacing:-0.55px;white-space:nowrap;overflow:visible;text-overflow:clip;' + voiceTextStyle + '">' + voicePrompt + '</div>' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex:none;color:' + voiceIconColor + ';">' +
            '<rect x="9" y="3" width="6" height="11" rx="3" stroke="currentColor" stroke-width="2" fill="none"/>' +
            '<path d="M5 11a7 7 0 0 0 14 0M12 18v3M9 21h6" stroke="currentColor" stroke-width="2" stroke-linecap="round" fill="none"/>' +
          '</svg>' +
        '</div>';
      }

      if (nbType === 'charging') {
        var percent = nbv.percent != null ? nbv.percent : 69;
        var chargeSurface = _themeSurfaceStyleRoot();
        var chargeIsFlat = chargeSurface === 'flat';
        var chargeIsNeon = chargeSurface === 'neon';
        var chargeIsGlass = chargeSurface === 'glass';
        // Neon: white track (unfilled / right), neon-green fill grows from the
        // left by percent — avoids the legacy two-layer gradient trick.
        if (chargeIsNeon) {
          var neonTrack = 'var(--nowbar-charging-track-bg, #ffffff)';
          var neonFill = 'var(--nowbar-charging-fill-bg, var(--surface-bg))';
          var neonBolt = 'var(--nowbar-charging-bolt-fill, var(--text-primary,#050805))';
          var neonPct = 'var(--nowbar-charging-percent-color, var(--text-primary,#050805))';
          var pctW = Math.max(0, Math.min(100, Number(percent)));
          if (isNaN(pctW)) pctW = 69;
          return '<div style="margin:0 auto;width:248px;height:64px;max-width:100%;' +
            'display:flex;flex-direction:row;align-items:center;padding:12px 18px 12px 12px;gap:14px;' +
            'isolation:isolate;position:relative;overflow:hidden;box-sizing:border-box;' +
            'background:' + neonTrack + ';' +
            'border:var(--surface-border, 1px solid rgba(5,8,5,0.14));' +
            'box-shadow:var(--surface-shadow, none);' +
            '-webkit-backdrop-filter:none;backdrop-filter:none;' +
            'border-radius:53px;font-family:var(--font);">' +
            '<div style="position:absolute;left:0;top:0;bottom:0;width:' + pctW + '%;max-width:100%;background:' + neonFill + ';z-index:0;pointer-events:none;"></div>' +
            '<div style="width:40px;height:40px;position:relative;z-index:1;flex:none;">' +
              '<div style="position:absolute;width:40px;height:40px;left:0;top:0;background:#5B53C8;opacity:0;border-radius:20px;"></div>' +
              '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="position:absolute;left:8px;top:8px;">' +
                '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="' + neonBolt + '"/>' +
              '</svg>' +
            '</div>' +
            '<div style="position:relative;z-index:2;flex:1 1 auto;min-width:0;height:23px;display:flex;align-items:center;justify-content:center;">' +
              '<div style="font-size:26px;font-weight:600;line-height:18px;color:' + neonPct + ';letter-spacing:-0.2px;font-feature-settings:\'pnum\' on, \'lnum\' on;">' + percent + '%</div>' +
            '</div>' +
            '<div style="width:24px;height:24px;opacity:0;position:relative;z-index:3;flex:none;"></div>' +
          '</div>';
        }
        var chargeFill = chargeIsFlat
          ? 'var(--accent-primary,#0381FE)'
          : (_isMonoChromaRoot()
            ? 'linear-gradient(90deg,#d5d5d5 0%,#aaaaae 35.93%,#78787d 100%)'
            : 'linear-gradient(90deg,#98DFA9 0%,#3BD18B 35.93%,#2E979F 100%)');
        var chargeSubtract = chargeIsFlat
          ? 'var(--accent-primary,#0381FE)'
          : (_isMonoChromaRoot()
            ? 'linear-gradient(90deg,#d8d8dc 0%,#a8a8ad 28.87%,#77777c 100%)'
            : 'linear-gradient(90deg,#9BDCA9 0%,#31CE8A 28.87%,#2F989F 100%)');
        var chargeMotionStyle = chargeIsFlat ? '' : 'background-size:180% 100%;animation:oneuiSurfaceShift 3.8s ease-in-out infinite alternate;';
        var chargeShimmer = chargeIsFlat ? '' : '<div style="position:absolute;width:157px;height:76px;left:-0.5px;bottom:0;background:linear-gradient(110deg,transparent 0%,transparent 34%,rgba(255,255,255,0.28) 50%,transparent 66%,transparent 100%);background-size:260% 100%;animation:aiShimmer 2.8s linear infinite;mix-blend-mode:screen;opacity:0.7;z-index:1;pointer-events:none;"></div>';
        var chargeShell = chargeIsGlass
          ? _G('panel')
          : 'background:var(--surface-bg, rgba(23,23,26,0.80));-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);';
        return '<div style="margin:0 auto;width:248px;height:64px;max-width:100%;' +
          'display:flex;flex-direction:row;align-items:center;padding:12px 18px 12px 12px;gap:14px;' +
          'isolation:isolate;position:relative;overflow:hidden;box-sizing:border-box;' +
          chargeShell +
          'border-radius:53px;color:var(--text-primary,#fff);font-family:var(--font);">' +
          '<div style="position:absolute;width:157px;height:76px;left:-0.5px;bottom:0;background:' + chargeFill + ';' + chargeMotionStyle + 'z-index:0;"></div>' +
          '<div style="position:absolute;width:154px;height:64px;left:-0.5px;top:0;background:' + chargeSubtract + ';' + chargeMotionStyle + 'z-index:0;"></div>' +
          chargeShimmer +
          '<div style="width:40px;height:40px;position:relative;z-index:1;flex:none;">' +
            '<div style="position:absolute;width:40px;height:40px;left:0;top:0;background:#5B53C8;opacity:0;border-radius:20px;"></div>' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="position:absolute;left:8px;top:8px;">' +
              '<path d="M13 2L4 14h7l-1 8 9-12h-7l1-8z" fill="#848487"/>' +
            '</svg>' +
          '</div>' +
          '<div style="position:relative;z-index:2;flex:1 1 auto;min-width:0;height:23px;display:flex;align-items:center;justify-content:center;">' +
            '<div style="font-size:26px;font-weight:600;line-height:18px;color:var(--text-primary,#fff);letter-spacing:-0.2px;font-feature-settings:\'pnum\' on, \'lnum\' on;">' + percent + '%</div>' +
          '</div>' +
          '<div style="width:24px;height:24px;opacity:0;position:relative;z-index:3;flex:none;"></div>' +
        '</div>';
      }

      // timer (default) — icon + 26px time + pause
      // When variant.live === true, adds data-live-timer so a global ticker
      // (see scenes.js _startLiveTimerTicker) increments the displayed time
      // every second. The `data-start` attribute records when the timer
      // began so we can compute elapsed seconds on each tick (survives
      // rerenders by using the wall-clock delta, not an accumulator).
      var tLabel = nbv.label || nbv.time || '00:00:00';
      var tIcon  = nbv.icon  || 'stopwatch';
      var showPause = nbv.showPause !== false;
      var iconBg = nbv.iconBg !== false;
      var isLive = nbv.live === true;
      var TIMER_ICONS = {
        'stopwatch':'<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="14" r="7" stroke="currentColor" stroke-width="1.6"/><path d="M12 11v3l2 1.5M10 3h4M14 5l1.5-1.5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>',
        'timer':    '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="8" stroke="currentColor" stroke-width="1.6"/><path d="M12 8v5l3 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/></svg>'
      };
      var timerSvg = TIMER_ICONS[tIcon] || TIMER_ICONS['stopwatch'];
      var liveAttrs = isLive ? ' data-live-timer="1" data-start="' + Date.now() + '"' : '';
      return '<div style="width:100%;' + common + _G('widgetPill') + '">' +
        '<div style="width:40px;height:40px;border-radius:20px;flex-shrink:0;display:flex;align-items:center;justify-content:center;color:var(--text-primary,#fff);' +
          (iconBg ? 'background:#5b53c8;' : '') + '">' + timerSvg + '</div>' +
        '<div style="flex:1;min-width:0;"><div' + liveAttrs + ' style="font-size:26px;font-weight:600;line-height:18px;color:var(--text-primary,#fff);letter-spacing:-0.2px;white-space:nowrap;font-family:Inter,system-ui,sans-serif;">' + tLabel + '</div></div>' +
        (showPause ? '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;color:var(--text-primary,#fff);"><rect x="7" y="5" width="3.5" height="14" fill="currentColor"/><rect x="13.5" y="5" width="3.5" height="14" fill="currentColor"/></svg>' : '') +
      '</div>';
    }

    case 'media-half': {
      // Figma "Media (Half | Off)" — node 544:967. Collapsed 199×163 glass
      // card shown when no media is active. Structure:
      //   container 199×163, bg rgba(23,23,26,0.6), border 1px rgba 0.2,
      //              rounded 36, padding 14 29
      //   inner stack (160w) vertically justify-between:
      //     1) Output chip — bg rgba(0,0,0,0.2) rounded 43, px-8 py-5,
      //          media-volume icon 19.7 + "Media Output" text 14/400
      //     2) Song row — play-triangle 19 + "No Media Playing" 15/500
      //     3) Progress line — thin 150.5 horizontal divider
      //     4) Controls — prev/play/next 24px icons, gap 21
      // All-interactive: each control has data-shortcut for press ripple.
      var mhv = (comp && comp.variant) || {};
      var mhTitle = mhv.title || 'No Media Playing';
      var mhOutput = mhv.output || 'Media Output';
      return '<div style="width:100%;height:100%;min-width:199px;' +
        _G('panel') +
        'border-radius:36px;padding:14px 29px;box-sizing:border-box;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;' +
        'color:var(--text-primary,#fff);font-family:var(--font);overflow:hidden;">' +
        '<div style="width:100%;display:flex;flex-direction:column;align-items:center;justify-content:space-between;gap:10px;flex:1;">' +
          // 1) Output chip
          '<div data-shortcut="1" style="display:flex;align-items:center;gap:6px;padding:6px 9px;background:rgba(0,0,0,0.2);border-radius:43px;cursor:pointer;">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="color:inherit;">' +
              '<path d="M4 10v4h3l4 3.5V6.5L7 10H4z" fill="currentColor"/>' +
              '<path d="M14 9.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>' +
            '</svg>' +
            '<span style="font-size:12px;font-weight:400;color:var(--text-primary,#fff);white-space:nowrap;">' + mhOutput + '</span>' +
          '</div>' +
          // 2) Song title row (play-triangle + "No Media Playing")
          '<div style="display:flex;align-items:center;gap:6px;justify-content:center;">' +
            '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;"><path d="M8 5l10 7-10 7V5z" fill="currentColor"/></svg>' +
            '<span style="font-size:13px;font-weight:500;letter-spacing:0.3px;color:var(--text-primary,#fff);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + mhTitle + '</span>' +
          '</div>' +
          // 3) Progress line (empty/inactive)
          '<div style="width:100%;height:2px;background:rgba(255,255,255,0.25);border-radius:1px;"></div>' +
          // 4) Controls row — prev / play / next
          '<div style="display:flex;align-items:center;gap:21px;">' +
            '<svg data-shortcut="1" width="22" height="22" viewBox="0 0 24 24" fill="none" style="cursor:pointer;color:var(--text-primary,#fff);"><path d="M6 5v14M18 5L8 12l10 7V5z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>' +
            '<svg data-shortcut="1" width="22" height="22" viewBox="0 0 24 24" fill="none" style="cursor:pointer;color:var(--text-primary,#fff);"><path d="M8 5l10 7-10 7V5z" fill="currentColor"/></svg>' +
            '<svg data-shortcut="1" width="22" height="22" viewBox="0 0 24 24" fill="none" style="cursor:pointer;color:var(--text-primary,#fff);"><path d="M18 5v14M6 5l10 7-10 7V5z" fill="currentColor" stroke="currentColor" stroke-width="1" stroke-linejoin="round"/></svg>' +
          '</div>' +
        '</div>' +
      '</div>';
    }

    case 'media-card': {
      // Full media player (background image + title + progress + 5 controls).
      var mcv = (comp && comp.variant) || {};
      var mTitle = mcv.title  || 'Title';
      var mArtist = mcv.artist || 'Artist';
      var mService = mcv.service || 'Samsung Music';
      return '<div style="width:100%;height:100%;border-radius:' + _R('dialog') + ';padding:14px 29px;box-sizing:border-box;color:#fff;display:flex;flex-direction:column;justify-content:space-between;background:linear-gradient(135deg,#2A1A5E,#1A0A3E 60%,#3A1A6E);overflow:hidden;position:relative;">' +
        // Service + output row
        '<div style="display:flex;justify-content:space-between;align-items:center;flex-shrink:0;">' +
          '<div style="display:flex;align-items:center;gap:6px;font-size:12px;letter-spacing:0.24px;">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M8 5v12a3 3 0 1 1-3-3m3 0V7l11-3v10a3 3 0 1 1-3-3m3 0V7" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
            '<span>' + mService + '</span>' +
          '</div>' +
          '<div style="background:rgba(0,0,0,0.2);border-radius:16px;padding:4px 8px;font-size:10px;display:flex;align-items:center;gap:4px;">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none"><rect x="6" y="3" width="12" height="18" rx="2" stroke="#fff" stroke-width="1.5"/></svg>' +
            '<span>Phone speaker</span>' +
          '</div>' +
        '</div>' +
        // Title + artist
        '<div style="display:flex;flex-direction:column;gap:2px;">' +
          '<div style="font-size:14px;font-weight:500;letter-spacing:0.28px;">' + mTitle + '</div>' +
          '<div style="font-size:12px;color:rgba(255,255,255,0.75);letter-spacing:0.24px;">' + mArtist + '</div>' +
        '</div>' +
        // Progress
        '<div style="display:flex;flex-direction:column;gap:3px;">' +
          '<div style="height:3px;background:rgba(255,255,255,0.25);border-radius:2px;position:relative;"><div style="position:absolute;left:0;top:0;bottom:0;width:45%;background:#fff;border-radius:2px;"></div><div style="position:absolute;left:45%;top:50%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:#fff;box-shadow:0 0 6px rgba(255,255,255,0.5);"></div></div>' +
          '<div style="display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,0.75);letter-spacing:0.2px;">' +
            '<span>02:41</span><span>03:24</span>' +
          '</div>' +
        '</div>' +
        // Controls (shuffle / prev / pause / next / heart)
        '<div style="display:flex;justify-content:space-between;align-items:center;padding:0 4px;">' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M3 7h3l3 3m6-3h4l-2-2m2 2l-2 2M3 17h3l8-10h4l-2 2m2-2l-2-2" stroke="#fff" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M18 5L8 12l10 7V5z" fill="#fff"/><rect x="5" y="5" width="2" height="14" fill="#fff"/></svg>' +
          '<svg width="26" height="26" viewBox="0 0 24 24" fill="none"><rect x="7" y="5" width="3.5" height="14" fill="#fff"/><rect x="13.5" y="5" width="3.5" height="14" fill="#fff"/></svg>' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 5l10 7-10 7V5z" fill="#fff"/><rect x="17" y="5" width="2" height="14" fill="#fff"/></svg>' +
          '<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" stroke="#fff" stroke-width="1.6" stroke-linejoin="round"/></svg>' +
        '</div>' +
      '</div>';
    }

    case 'notif-card': {
      // Figma Notification/Regular — node 544:1088. Samsung OneUI 8.5 pill
      // shape with 56×56 app icon + title/time row + subtitle + chevron.
      //
      //   container  → 415×86, rounded 50, padding 15 / 16 / 20, gap 10
      //   icon       → 56×56 circle, app accent bg or png icon inside
      //
      //   theme='light' ONLY when preset is Default (`surface style === base`) —
      //   avoids white pills on Neon / Gradient / Glass when upstream still sends
      //   theme: light for Home-adjacent mock data.
      //   theme='dark' everywhere else → tokenized surface + ink
      var ncv = (comp && comp.variant) || {};
      var ncSurfRoot = _themeSurfaceStyleRoot();
      var ncThemeFlag = ncv.theme === 'light' ? 'light' : 'dark';
      var ncBaselineLight = ncThemeFlag === 'light' && ncSurfRoot === 'base';
      var ncTitle = ncv.title || ncv.app || 'Title';
      var ncBody  = ncv.body  || ncv.subtitle || '';
      var ncTime  = ncv.time  || '';
      var ncAccent= ncv.accent|| '#d5d5d5';
      var ncIcon  = ncv.icon  || null;
      var ncGlyph = ncv.glyph || '';
      var ncShowSub = !!ncBody;

      var ncBg, ncBlur, ncTitleColor, ncTimeColor, ncSubColor, ncChevronColor;
      if (ncBaselineLight) {
        ncBg = '#ffffff';
        ncBlur = '';
        ncTitleColor = '#000000';
        ncTimeColor = '#555555';
        ncSubColor = '#333333';
        ncChevronColor = '#222222';
      } else if (ncSurfRoot === 'neon') {
        ncBg = 'var(--surface-bg, #b8ff42)';
        ncBlur = '';
        ncTitleColor = 'var(--text-primary,#050805)';
        ncTimeColor = 'var(--text-secondary,rgba(5,8,5,0.72))';
        ncSubColor = 'var(--text-secondary,rgba(5,8,5,0.72))';
        ncChevronColor = 'var(--text-primary,#050805)';
      } else {
        ncBg = 'rgba(23,23,26,0.6)';
        ncBlur = '-webkit-backdrop-filter:blur(12px);backdrop-filter:blur(12px);';
        ncTitleColor = 'var(--text-primary,#efeef2)';
        ncTimeColor = 'var(--text-secondary,#d5d5d5)';
        ncSubColor = 'var(--text-secondary,#cfcccf)';
        ncChevronColor = 'var(--text-primary,#ffffff)';
      }

      // 56×56 circular app icon. Uses the png if provided, else a colored
      // circle with the glyph fallback. Matches Figma Shape (548:2740).
      var ncIconHTML = ncIcon
        ? '<img src="app-icons/' + ncIcon + '" style="width:56px;height:56px;border-radius:50%;flex-shrink:0;object-fit:cover;"/>'
        : '<div style="width:56px;height:56px;border-radius:50%;background:' + ncAccent +
            ';display:flex;align-items:center;justify-content:center;flex-shrink:0;' +
            'color:#fff;font-size:22px;font-weight:600;line-height:1;">' + ncGlyph + '</div>';

      var ncSurface = ncBaselineLight
        ? 'background:' + ncBg + ';' + ncBlur
        : (ncSurfRoot === 'neon'
          ? 'background:' + ncBg + ';border:var(--surface-border);box-shadow:var(--surface-shadow);-webkit-backdrop-filter:none;backdrop-filter:none;'
          : _G('panel'));
      return '<div style="width:415px;height:86px;max-width:100%;' +
        ncSurface +
        'border-radius:50px;padding:15px 20px 15px 16px;box-sizing:border-box;' +
        'display:flex;align-items:center;gap:10px;overflow:hidden;font-family:var(--font);">' +
        ncIconHTML +
        // Stacked unit — title+time row (baseline aligned) on top, subtitle below
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;justify-content:center;overflow:hidden;">' +
          '<div style="display:flex;align-items:baseline;gap:8px;white-space:nowrap;overflow:hidden;">' +
            '<span style="font-size:15px;font-weight:600;color:' + ncTitleColor + ';overflow:hidden;text-overflow:ellipsis;">' + ncTitle + '</span>' +
            (ncTime ? '<span style="font-size:12px;font-weight:400;color:' + ncTimeColor + ';flex-shrink:0;">' + ncTime + '</span>' : '') +
          '</div>' +
          (ncShowSub
            ? '<div style="font-size:14px;font-weight:400;color:' + ncSubColor + ';white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:2px;">' + ncBody + '</div>'
            : '') +
        '</div>' +
        // Chevron-down expand affordance (Figma node 745:7185, opacity 0.8)
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="flex-shrink:0;opacity:0.8;"><path d="M6 9l6 6 6-6" stroke="' + ncChevronColor + '" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
      '</div>';
    }

    case 'notif-card-ai': {
      // Notification variant with AI blue→green gradient + animated
      // shimmer overlay (slow, ambient — signals "AI is processing"
      // without being noisy). Sparkle glyph in a glass circle. App
      // name + time on top line, body below. Empty fallbacks return
      // empty rather than the "Title/Subtitle" placeholder antipattern.
      var naiv = (comp && comp.variant) || {};
      var aiTheme = naiv.theme === 'light' ? 'light' : 'dark';
      var aiTitle = (naiv.title && naiv.title !== 'Title') ? naiv.title : '';
      var aiSub   = (naiv.subtitle && naiv.subtitle !== 'Subtitle') ? naiv.subtitle : (naiv.body || '');
      var aiTime  = naiv.time || '';
      var aiSurface = _themeSurfaceStyleRoot();
      var aiBaselineLight = aiTheme === 'light' && aiSurface === 'base';
      // Tinted / gradient fills: keep light ink — global `--text-primary` may
      // be dark (pastel presets) while the AI pill stays chromatic translucent.
      var aiTinted = !aiBaselineLight && aiSurface !== 'flat' && aiSurface !== 'neon';
      var aiTitleColor = aiBaselineLight ? '#111111' :
        aiTinted ? '#ffffff' : 'var(--text-primary,#efeef2)';
      var aiTimeColor  = aiBaselineLight ? '#444444' :
        aiTinted ? 'rgba(255,255,255,0.78)' : 'var(--text-secondary,rgba(239,238,242,0.7))';
      var aiSubColor   = aiBaselineLight ? '#222222' :
        aiTinted ? 'rgba(255,255,255,0.82)' : 'var(--text-secondary,rgba(239,238,242,0.85))';
      var aiChevColor  = aiBaselineLight ? '#111111' :
        aiTinted ? '#ffffff' : 'var(--text-primary,#ffffff)';
      var aiSparkFill = aiSurface === 'neon'
        ? 'var(--text-primary,#050805)'
        : (aiBaselineLight ? '#111111' : 'var(--text-primary,#ffffff)');
      // Richer gradient: blue → purple → teal — three-stop AI signature.
      // Theme-driven via --card-ai-grad. Light mode keeps a stronger
      // gradient (no backdrop blur); dark mode uses a translucent one.
      var aiGrad = (aiSurface === 'flat' || aiSurface === 'neon')
        ? 'var(--card-ai-grad, var(--surface-bg, rgba(23,23,26,0.80)))'
        : (aiBaselineLight
          ? 'linear-gradient(120deg, rgba(102,161,243,1) 0%, rgba(167,139,250,1) 50%, rgba(34,201,166,1) 100%)'
          : 'var(--card-ai-grad, linear-gradient(120deg, rgba(102,161,243,0.45) 0%, rgba(167,139,250,0.45) 50%, rgba(34,201,166,0.45) 100%))');
      var aiSurfaceStyle = aiSurface === 'glass' ? _G('panel') : 'background:' + aiGrad + ';';
      // Shimmer overlay — animated white sweep, very subtle. Speed
      // tunable via --card-ai-shimmer-speed for theme variations.
      var shimmerSpeed = (getComputedStyle(document.documentElement).getPropertyValue('--card-ai-shimmer-speed') || '3.6s').trim();
      var shimmerOff = shimmerSpeed === '0s' || shimmerSpeed === '0ms';
      var shimmer = (aiSurface === 'flat' || aiSurface === 'neon' || shimmerOff) ? '' : '<div style="position:absolute;inset:0;background:linear-gradient(110deg,transparent 0%,transparent 35%,rgba(255,255,255,0.10) 50%,transparent 65%,transparent 100%);background-size:300% 100%;animation:aiShimmer var(--card-ai-shimmer-speed,3.6s) linear infinite;pointer-events:none;border-radius:inherit;"></div>';
      var aiIconBubble = aiSurface === 'neon'
        ? 'background:var(--surface-bg,#b8ff42);-webkit-backdrop-filter:none;backdrop-filter:none;border:1px solid rgba(5,8,5,0.14);'
        : 'background:rgba(255,255,255,0.22);-webkit-backdrop-filter:blur(8px);backdrop-filter:blur(8px);border:1px solid rgba(255,255,255,0.3);';
      return '<div style="position:relative;width:415px;height:86px;max-width:100%;' + aiSurfaceStyle + 'border-radius:50px;padding:15px 20px 15px 16px;display:flex;align-items:center;gap:10px;box-sizing:border-box;overflow:hidden;">' +
        shimmer +
        '<div style="position:relative;z-index:1;width:56px;height:56px;border-radius:50%;' + aiIconBubble + 'flex-shrink:0;display:flex;align-items:center;justify-content:center;">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none"><path d="M12 3l1.8 4.5L18 9l-4.2 1.5L12 15l-1.8-4.5L6 9l4.2-1.5L12 3zM18 15l.9 2.2L21 18l-2.1.8L18 21l-.9-2.2L15 18l2.1-.8L18 15z" fill="' + aiSparkFill + '"/></svg>' +
        '</div>' +
        '<div style="position:relative;z-index:1;flex:1;min-width:0;display:flex;flex-direction:column;gap:3px;overflow:hidden;">' +
          (aiTitle || aiTime
            ? '<div style="display:flex;gap:8px;align-items:baseline;white-space:nowrap;overflow:hidden;">' +
                (aiTitle ? '<span style="font-size:15px;font-weight:600;color:' + aiTitleColor + ';">' + aiTitle + '</span>' : '') +
                (aiTime  ? '<span style="font-size:12px;color:' + aiTimeColor + ';">' + aiTime + '</span>'   : '') +
              '</div>'
            : '') +
          (aiSub
            ? '<div style="font-size:14px;color:' + aiSubColor + ';line-height:1.4;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + aiSub + '</div>'
            : '') +
        '</div>' +
        '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="position:relative;z-index:1;opacity:0.8;flex-shrink:0;"><path d="M7 10l5 5 5-5" stroke="' + aiChevColor + '" stroke-width="1.5" stroke-linecap="round"/></svg>' +
      '</div>';
    }

    case 'output-chip': {
      // Small pill — media device indicator ("Phone speaker").
      var ocv = (comp && comp.variant) || {};
      var ocLabel = ocv.label || 'Phone speaker';
      return '<div style="display:inline-flex;align-items:center;gap:6px;padding:5px 10px;background:rgba(0,0,0,0.35);border-radius:16px;font-size:11px;color:#fff;white-space:nowrap;margin:auto;">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><rect x="6" y="3" width="12" height="18" rx="2" stroke="#fff" stroke-width="1.5"/><circle cx="12" cy="17" r="1" fill="#fff"/></svg>' +
        '<span>' + ocLabel + '</span>' +
      '</div>';
    }

    case 'progress-track': {
      // Time progress bar with left/right timestamps.
      var ptv = (comp && comp.variant) || {};
      var left  = ptv.left  || '02:41';
      var right = ptv.right || '03:24';
      var ptPct = ptv.percent != null ? ptv.percent : 45;
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;gap:3px;justify-content:center;padding:0 4px;box-sizing:border-box;">' +
        '<div style="height:3px;background:rgba(255,255,255,0.25);border-radius:2px;position:relative;"><div style="position:absolute;left:0;top:0;bottom:0;width:' + ptPct + '%;background:#fff;border-radius:2px;"></div><div style="position:absolute;left:' + ptPct + '%;top:50%;transform:translate(-50%,-50%);width:10px;height:10px;border-radius:50%;background:#fff;"></div></div>' +
        '<div style="display:flex;justify-content:space-between;font-size:10px;color:rgba(255,255,255,0.75);">' +
          '<span>' + left + '</span><span>' + right + '</span>' +
        '</div>' +
      '</div>';
    }

    case 'clock':         // canonical Scene template name
    case 'lock-clock':    // kebab alias
    case 'lock-time': {   // legacy alias
      // Huge digital time display — Samsung lock-screen signature.
      // Delegates to GalaxyAtomics.Clock when available so the render
      // matches the canned Screen/Lock scene 1:1: HH on line 1, MM on
      // line 2 (NO COLON between them), FONT_CLOCK family
      // ('SamsungNrDefault-V6'), weight 400, size 112, line-height 82,
      // gap 12. Earlier version rendered "HH:MM" on one line with the
      // Inter fallback and weight 200 — visually inconsistent with the
      // canonical Scene/Lock.
      var lcv = (comp && comp.variant) || {};
      var _now = new Date();
      var _HH = lcv.HH != null ? String(lcv.HH)
        : String(_now.getHours()).padStart(2, '0');
      var _MM = lcv.MM != null ? String(lcv.MM)
        : String(_now.getMinutes()).padStart(2, '0');
      // `A` (= window.GalaxyAtomics) is already in scope from the top
      // of renderAtomicForRole — reuse it directly.
      if (A && typeof A.Clock === 'function') {
        return A.Clock({
          time:       [_HH, _MM],
          fontSize:   lcv.fontSize || 112,
          lineHeight: lcv.lineHeight || 82,
          gap:        lcv.gap != null ? lcv.gap : 12,
          family:     lcv.family || null
        });
      }
      // Fallback (when GalaxyAtomics hasn't loaded yet) — still
      // renders 2-line no-colon using the canonical clock font stack.
      // Space Grotesk paired with Inter structural fallback, matching
      // the project-wide Inter + Space Grotesk standardization.
      var lcSize = lcv.fontSize || 112;
      var lcLh   = lcv.lineHeight || 82;
      var lcGap  = lcv.gap != null ? lcv.gap : 12;
      var lcFont = lcv.family || "'Space Grotesk', Inter, system-ui, sans-serif";
      var baseStyle = 'font-family:' + lcFont + ';font-weight:400;font-size:' + lcSize + 'px;' +
                      'line-height:' + lcLh + 'px;color:#FFFFFF;text-align:center;white-space:nowrap;';
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:' + lcGap + 'px;">' +
        '<div style="' + baseStyle + '">' + _HH + '</div>' +
        '<div style="' + baseStyle + '">' + _MM + '</div>' +
      '</div>';
    }

    case 'weatherDate':       // canonical Scene template name
    case 'weather-date': {
      // Canonical Samsung Lock weather-date row — matches
      // GalaxyAtomics.WeatherDate exactly so the agent path renders
      // identically to Scene/Lock:
      //   layout  : [date] [moon-or-condition icon 19×19] [temp°]
      //   font    : Inter, 24px / 400 / line-height 20px / #FFFFFF
      //   gap     : 10px between items
      //   width   : 192 centered (CANONICAL_ROLE_SIZES enforces this)
      // Earlier revision rendered icon-first + bullet separator + 14px
      // font-weight 500 — visually off by a mile. Now we delegate to
      // GalaxyAtomics.WeatherDate when available, with a condition-
      // aware icon override via an inline wrapper.
      //
      // variant fields accepted:
      //   condition → 'sunny' | 'cloudy' | 'rain' | 'snow' | 'moon'
      //                (default 'moon' — matches canonical night look)
      //   temp      → numeric '24' or string '24°' (degree auto-appended)
      //   date      → string 'Sat, May 3'
      var wdv = (comp && comp.variant) || {};
      var wdCond = wdv.condition || 'moon';
      // Strip trailing ° if present; canonical appends it.
      var wdTempRaw = (wdv.temp != null ? wdv.temp : 24);
      var wdTempStr = String(wdTempRaw).replace(/[°\s]+$/, '');
      var wdDate = wdv.date || 'Sat, May 3';

      // Default look = moon.svg (canonical Lock is night-themed).
      // For other conditions use inline SVGs so we don't depend on
      // missing PNG/SVG assets. Sun/cloud/rain/snow all styled to
      // match the 19×19 footprint of moon.svg.
      var WEATHER_INLINE = {
        'sunny':  '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><circle cx="12" cy="12" r="4" fill="#fff"/><path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.5 5.5l1.5 1.5M17 17l1.5 1.5M5.5 18.5l1.5-1.5M17 7l1.5-1.5" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
        'cloudy': '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M7 17a4 4 0 0 1 0-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 17H7z" fill="#fff"/></svg>',
        'rain':   '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M7 14a4 4 0 0 1 0-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 14H7z" fill="#fff"/><path d="M9 17v3M12 17v3M15 17v3" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>',
        'snow':   '<svg width="19" height="19" viewBox="0 0 24 24" fill="none"><path d="M7 13a4 4 0 0 1 0-8 5 5 0 0 1 9.5 1.5A3.5 3.5 0 0 1 17 13H7z" fill="#fff"/><path d="M8 17v2M12 17v2M16 17v2" stroke="#fff" stroke-width="1.6" stroke-linecap="round"/></svg>'
      };
      // Canonical moon.svg lives in assets/figma/lock-screen — if it
      // loads we use that; otherwise inline moon SVG fallback.
      var moonInline =
        '<svg width="19" height="19" viewBox="0 0 24 24" fill="none">' +
          '<path d="M20 14.5A8 8 0 1 1 9.5 4c-.3 1-.5 2-.5 3a7 7 0 0 0 11 7.5z" fill="#fff"/>' +
        '</svg>';
      var iconSvg = WEATHER_INLINE[wdCond] || moonInline;

      // Canonical typography: Inter 24/400/20 line-height
      var textStyle = "font-family:'One UI Sans APP VF', Inter, system-ui, sans-serif;" +
                      'font-weight:400;font-size:24px;line-height:20px;color:#FFFFFF;' +
                      'white-space:nowrap;text-shadow:0 1px 4px rgba(0,0,0,0.35);';
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;gap:10px;">' +
        '<span style="' + textStyle + '">' + wdDate + '</span>' +
        '<div style="position:relative;width:19px;height:19px;flex-shrink:0;display:flex;align-items:center;justify-content:center;">' + iconSvg + '</div>' +
        '<span style="' + textStyle + '">' + wdTempStr + '\u00b0</span>' +
      '</div>';
    }

    case 'lockIndicator':       // canonical Scene template name
    case 'lock-indicator': {
      // Small padlock / fingerprint / face-ID glyph shown just below the
      // status bar. variant.state: 'locked' | 'unlocked' | 'fingerprint'.
      var liv = (comp && comp.variant) || {};
      var liState = liv.state || 'locked';
      var LOCK_SVGS = {
        'locked':      '<rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 11V7a4 4 0 0 1 8 0v4" stroke="currentColor" stroke-width="1.8" fill="none"/>',
        'unlocked':    '<rect x="5" y="11" width="14" height="10" rx="2" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M8 11V7a4 4 0 0 1 8 0" stroke="currentColor" stroke-width="1.8" fill="none"/>',
        'fingerprint': '<path d="M12 5a7 7 0 0 0-7 7v3M19 12a7 7 0 0 0-3-5.7M19 15v3M8 21a7 7 0 0 0 2-5v-4a2 2 0 0 1 4 0v5a9 9 0 0 1-1 4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" fill="none"/>'
      };
      var liSvg = LOCK_SVGS[liState] || LOCK_SVGS['locked'];
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;color:rgba(255,255,255,0.9);filter:drop-shadow(0 1px 4px rgba(0,0,0,0.35));">' +
        '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="color:currentColor;">' + liSvg + '</svg>' +
      '</div>';
    }

    case 'shortcutLeft':
    case 'shortcutRight': {
      // Canonical Samsung lockscreen shortcut — 47×47 glass circle with
      // a single glyph (phone on the left by default, camera on the
      // right). variant.icon picks the glyph.
      var scv = (comp && comp.variant) || {};
      var scIcon = scv.icon || (comp.role === 'shortcutRight' ? 'camera' : 'phone');
      var SHORTCUT_SVGS = {
        'phone':  '<path d="M5 4h3l2 5-2.5 1.5a11 11 0 0 0 5 5L14 13l5 2v3a2 2 0 0 1-2 2 17 17 0 0 1-16-16 2 2 0 0 1 2-2z" fill="currentColor"/>',
        'camera': '<path d="M4 7h3l2-2h6l2 2h3a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V9a2 2 0 0 1 2-2z" stroke="currentColor" stroke-width="1.6" fill="none"/><circle cx="12" cy="13" r="3.5" stroke="currentColor" stroke-width="1.6" fill="none"/>',
        'flash':  '<path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z" fill="currentColor"/>',
        'qr':     '<rect x="3" y="3" width="7" height="7" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="14" y="3" width="7" height="7" stroke="currentColor" stroke-width="1.6" fill="none"/><rect x="3" y="14" width="7" height="7" stroke="currentColor" stroke-width="1.6" fill="none"/><path d="M14 14h3v3M19 14v7M14 19h3v2" stroke="currentColor" stroke-width="1.6" fill="none"/>'
      };
      var scSvg = SHORTCUT_SVGS[scIcon] || SHORTCUT_SVGS['phone'];
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;' +
        _G('shortcutCircle') + 'border-radius:50%;color:#fff;' +
      '">' +
        '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="color:currentColor;">' + scSvg + '</svg>' +
      '</div>';
    }

    case 'gestureBar': {
      // Full-width bottom home-gesture indicator (Samsung's Android home
      // bar). Thin light pill, 134×5 centered in a 451×24 band.
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;">' +
        '<div style="width:134px;height:5px;border-radius:3px;background:rgba(255,255,255,0.85);"></div>' +
      '</div>';
    }

    case 'unlock-hint': {
      // "Swipe up to unlock" text with optional up-chevron above. Centered
      // at the bottom of the lock screen, just above the shortcut row.
      var uhv = (comp && comp.variant) || {};
      var uhText = uhv.text != null ? uhv.text : 'Swipe up to unlock';
      var uhArrow = uhv.showArrow !== false;
      return '<div style="width:100%;height:100%;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;color:rgba(255,255,255,0.8);font-family:var(--font);font-size:12px;font-weight:500;text-shadow:0 1px 4px rgba(0,0,0,0.35);">' +
        (uhArrow
          ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" style="color:rgba(255,255,255,0.7);"><path d="M7 15l5-5 5 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
          : '') +
        '<span>' + uhText + '</span>' +
      '</div>';
    }

    case 'slider-panel': {
      // Figma 1109:10261 (brightness) / 1109:10246 (volume) — a vertical
      // slider PANEL that bundles a track + mode-cap toggle in one glass
      // container. Exact spec:
      //   container: 88×h, bg rgba(23,23,26,0.6) + 1px border + rounded-50
      //               padding 18, flex-col, gap 10
      //   track:      fills remaining vertical space (rotated slider-pill)
      //   cap:        56 circle at bottom, active by default (#d5d5d5 bg)
      //
      // variant:
      //   icon    → slider handle glyph ('brightness' | 'music' | …)
      //   capIcon → mode cap glyph ('moon' | 'mute' | …)
      //   capOn   → cap active state (default true — matches Figma)
      //   percent → slider fill 0..100
      var spnv = (comp && comp.variant) || {};
      var spnPct    = spnv.percent != null ? spnv.percent : 62;
      var spnIcon   = spnv.icon    || 'brightness';
      var spnCapI   = spnv.capIcon || 'moon';
      var spnCapOn  = spnv.capOn !== false; // default true per Figma
      var spnSlider = window.renderAtomicForRole(
        { role: 'slider-pill', variant: { orient: 'vertical', icon: spnIcon, percent: spnPct } },
        { w: 56, h: 200 }
      );
      var spnCap = window.renderAtomicForRole(
        { role: 'toggle-chip', variant: { icon: spnCapI, on: spnCapOn } },
        { w: 56, h: 56 }
      );
      return '<div style="width:100%;height:100%;' +
        _G('panel') +
        'border-radius:var(--card-radius,' + _R('widget') + ');' +
        'padding:18px;box-sizing:border-box;' +
        'display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;' +
        'overflow:hidden;">' +
        '<div style="flex:1;min-height:0;width:100%;display:flex;align-items:stretch;justify-content:center;">' + spnSlider + '</div>' +
        '<div style="flex-shrink:0;width:56px;height:56px;">' + spnCap + '</div>' +
      '</div>';
    }

    case 'single-toggle': {
      // Figma "Single Toggle" component (1003:13051, 1003:13038, 1006:14473,
      // 1006:14489). Four exact variant combinations:
      //   width='single' + kind='toggle'   → 88×88  icon-only (Figma 987:17561)
      //   width='single' + kind='shortcut' → 88×88  open-arrow only (985:13445)
      //   width='half'   + kind='toggle'   → 199×88 icon + title/sub (544:1012)
      //   width='half'   + kind='shortcut' → 199×88 arrow + title/sub (544:1044)
      // Glass pill: bg rgba(23,23,26,0.6), border 1px rgba(255,255,255,0.2),
      //             rounded 50.
      var stv = (comp && comp.variant) || {};
      var stWidth = stv.width || 'half';
      var stKind  = stv.kind  || 'toggle';
      var stTitle = stv.title || 'Title';
      var stSub   = stv.sub || stv.subtitle || 'Subtitle';
      var stShowSub = stv.showSubtitle !== false;
      var stIcon  = stv.icon || 'add';
      var stOn    = stv.on === true;
      var glass   = _G('panel') + 'border-radius:var(--card-radius,' + _R('widget') + ');box-sizing:border-box;';

      // Reusable 56-circle. Delegates to the `toggle-chip` atomic so the
      // full icon library (Wi-Fi / Mobile Data / Bluetooth / …) is picked
      // up correctly — previously this helper was hardcoded to check/plus
      // glyphs, which made every single-toggle render the wrong icon.
      function _stChip(on, iconKey) {
        return window.renderAtomicForRole(
          { role: 'toggle-chip', variant: { icon: iconKey, on: on } },
          { w: 56, h: 56 }
        );
      }
      // Shortcut left icon — 34×34 in a 32.5×35 holder (per Figma). Default
      // is the "open" arrow (navigation cue). `variant.icon` can override
      // with any key in SHORTCUT_ICONS below — e.g. 'song-search' renders
      // the Figma media_volume speaker+waves glyph (node 340:8807) for the
      // Samsung Song Search affordance.
      var SHORTCUT_ICONS = {
        'open':        '<path d="M14 5h5v5M19 5l-9 9M10 7H7a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h8a2 2 0 0 0 2-2v-3" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        // Figma 340:8807 media_volume — speaker cone + two wave arcs.
        // Proportions match the 19.69%/14.04%/24.53%/14.32% insets at 24×24.
        'song-search':'<path d="M4 10v4h3l4 3.5V6.5L7 10H4z" fill="currentColor"/>' +
                      '<path d="M14 9.5a3.5 3.5 0 0 1 0 5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>' +
                      '<path d="M17 6.5a7 7 0 0 1 0 11" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" fill="none"/>',
        'smart-view': '<rect x="3" y="5" width="18" height="11" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/><path d="M10 9l5 2.5-5 2.5V9z" fill="currentColor"/>'
      };
      function _stShortcutIcon(iconKey) {
        var path = SHORTCUT_ICONS[iconKey] || SHORTCUT_ICONS['open'];
        // Holder sized to match the toggle chip's 56 circle footprint, with
        // the SVG rendered at 26px for clear visibility. Figma's raw
        // 32.5×35 + p-13 holder math would clip the glyph to ~7×9, which
        // is what caused the "icons are too small" bug in the reference.
        return '<div style="width:40px;height:40px;display:flex;align-items:center;justify-content:center;flex-shrink:0;color:var(--text-primary,#fff);">' +
          '<svg width="26" height="26" viewBox="0 0 24 24" fill="none" style="color:inherit;">' + path + '</svg>' +
        '</div>';
      }
      // Shortcut variants get `data-shortcut` so the delegated interact-mode
      // click handler can flash a quick press animation — navigation-style
      // feedback without needing to route to a real destination.
      var shortcutAttr = (stKind === 'shortcut') ? ' data-shortcut="1"' : '';

      if (stWidth === 'single') {
        // 88×88 centered. 'toggle' = 56 circle; 'shortcut' = 34 arrow.
        var innerSingle = stKind === 'shortcut' ? _stShortcutIcon(stIcon) : _stChip(stOn, stIcon);
        return '<div' + shortcutAttr + ' style="width:88px;height:88px;max-width:88px;max-height:88px;' + glass +
          'display:flex;align-items:center;justify-content:center;transition:transform 120ms ease,background 160ms ease;' +
          (stKind === 'shortcut' ? 'padding:24px;' : 'padding:10px 0;') + '">' +
          innerSingle +
        '</div>';
      }

      // half: 199×88 — left icon (toggle or shortcut) + title/sub stacked right.
      var leftHalf = stKind === 'shortcut' ? _stShortcutIcon(stIcon) : _stChip(stOn, stIcon);
      var padX = stKind === 'shortcut' ? 'padding:24px 25px 24px 20px;' : 'padding:24px 17px;';
      return '<div' + shortcutAttr + ' style="width:199px;height:88px;max-height:88px;' + glass + padX +
        'display:flex;flex-direction:column;align-items:flex-start;justify-content:center;overflow:hidden;color:var(--text-primary,#fff);font-family:var(--font);transition:transform 120ms ease,background 160ms ease;">' +
        '<div style="display:flex;align-items:center;gap:10px;width:100%;">' +
          leftHalf +
          '<div style="flex:1;min-width:0;display:flex;flex-direction:column;overflow:hidden;">' +
            '<div style="font-size:16px;font-weight:600;color:var(--text-primary,#efeef2);line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + stTitle + '</div>' +
            (stShowSub ? '<div style="font-size:14px;font-weight:400;color:var(--text-secondary,rgba(239,238,242,0.72));line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + stSub + '</div>' : '') +
          '</div>' +
        '</div>' +
      '</div>';
    }

    case 'smart-things': {
      // Figma SmartThings (1006:14505 / 544:1020) — 415×88, glass pill
      // with a device icon + 2-line title/sub on the left and up to 3
      // circular action toggles on the right. Every dimension mirrors the
      // Figma component 1:1. variant.actions = array of up to 3 icon keys.
      var stmv = (comp && comp.variant) || {};
      var stmTitle = stmv.title || 'Title';
      var stmSub   = stmv.sub || stmv.subtitle || 'Subtitle';
      var stmShowSub = stmv.showSubtitle !== false;
      // actionCount: 1 (compact — single output chip on right, as in the
      //              QS compact/minimal reference) or 3 (Full — Figma default).
      // variant.actions explicit array overrides actionCount.
      var stmActionCount = (stmv.actionCount === 1) ? 1 : 3;
      var stmActions = Array.isArray(stmv.actions)
        ? stmv.actions.slice(0, 3)
        : (stmActionCount === 1
          ? ['power']
          : ['smart-view', 'remote', 'power']);
      var stmActiveIdx = (stmv.activeIndex != null) ? stmv.activeIndex : -1;

      // Device icon on the left — Figma 552:1513 "tv outline" glyph.
      //   screen: rounded rectangle (~17.5×11.5) with stroke
      //   stand: horizontal bar at the bottom
      //   stem: thin vertical line connecting screen to stand
      // Rendered at 30×30 SVG inside a 44×44 holder so the glyph reads
      // clearly alongside the title text (matches Figma visual weight even
      // though we abandoned Figma's clipped 32.5×35 p-13 container math).
      var deviceGlyph = '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:var(--text-primary,#efeef2);">' +
        '<rect x="3" y="4" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.8" fill="none"/>' +
        '<path d="M8 20h8" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
        '<path d="M12 16v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>' +
      '</svg>';

      var ACTION_SVGS = {
        'smart-view': '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#fff;"><rect x="3" y="5" width="18" height="12" rx="1.5" stroke="currentColor" stroke-width="1.6"/><path d="M12 9l4 2.5-4 2.5V9z" fill="currentColor"/></svg>',
        'remote':     '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#fff;"><rect x="6" y="3" width="12" height="18" rx="2" stroke="currentColor" stroke-width="1.6"/><circle cx="12" cy="7" r="1.3" fill="currentColor"/><path d="M9 11h6M9 14h6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>',
        'power':      '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#222;"><path d="M12 4v8M6.5 7a7 7 0 1 0 11 0" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>',
        'refresh':    '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#fff;"><path d="M4 12a8 8 0 0 1 14-5l2-2M20 7v4h-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        'play':       '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#fff;"><path d="M8 5l10 7-10 7V5z" fill="currentColor"/></svg>',
        'add':        '<svg width="30" height="30" viewBox="0 0 24 24" fill="none" style="color:#fff;"><path d="M12 5v14M5 12h14" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>'
      };
      var actionsHtml = stmActions.map(function (key, i) {
        var active = i === stmActiveIdx;
        var bg = active ? '#d5d5d5' : 'rgba(180,180,180,0.2)';
        var glyph = ACTION_SVGS[key] || ACTION_SVGS['add'];
        // When active, swap stroke to dark so the glyph is visible on #d5d5d5
        if (active) glyph = glyph.replace("color:#fff", "color:#222");
        return '<div data-toggle-chip data-on="' + (active ? '1' : '0') + '" ' +
          'style="width:51.67px;height:51.67px;aspect-ratio:1;border-radius:63.636px;' +
            'background:' + bg + ';display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + glyph + '</div>';
      }).join('');

      return '<div style="width:415px;height:88px;max-height:88px;' +
        _G('panel') +
        'border-radius:var(--card-radius,' + _R('widget') + ');padding:24px 17px 24px 20px;gap:20px;box-sizing:border-box;' +
        'display:flex;align-items:center;overflow:hidden;color:var(--text-primary,#fff);font-family:var(--font);">' +
        // Left: icon + title/sub
        '<div style="flex:1;min-width:0;display:flex;align-items:center;gap:10px;">' +
          '<div style="width:44px;height:44px;display:flex;align-items:center;justify-content:center;flex-shrink:0;">' + deviceGlyph + '</div>' +
          '<div style="display:flex;flex-direction:column;min-width:0;">' +
            '<div style="font-size:16px;font-weight:600;color:var(--text-primary,#efeef2);line-height:1.2;width:138px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + stmTitle + '</div>' +
            (stmShowSub ? '<div style="font-size:14px;font-weight:400;color:var(--text-secondary,rgba(239,238,242,0.72));line-height:1.3;width:138px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + stmSub + '</div>' : '') +
          '</div>' +
        '</div>' +
        // Right: action circles
        '<div style="flex:1;min-width:0;display:flex;align-items:center;justify-content:flex-end;gap:10px;">' + actionsHtml + '</div>' +
      '</div>';
    }

    case 'control-pill': {
      // QS control row: left circular icon + 2-line text + optional right
      // icon. Used for "SmartThings / Device control" and stand-alone
      // "Modes" row in the three QS states. variant keys:
      //   icon: 'smartthings'|'modes'|'wifi' — left circle glyph
      //   title, sub: two text lines
      //   rightIcon: 'refresh'|'chevron'|null — right-side accessory
      var cpv = (comp && comp.variant) || {};
      var cpIcon = cpv.icon || 'smartthings';
      var cpTitle = cpv.title || 'SmartThings';
      var cpSub   = cpv.sub || '';
      var cpRight = cpv.rightIcon || null;
      var LEFT_SVGS = {
        'smartthings':'<circle cx="12" cy="12" r="2.2" fill="#222"/><circle cx="12" cy="5" r="1.6" fill="#222"/><circle cx="12" cy="19" r="1.6" fill="#222"/><circle cx="5" cy="12" r="1.6" fill="#222"/><circle cx="19" cy="12" r="1.6" fill="#222"/><path d="M12 7.5v3M12 13.5v3M7 12h3M14 12h3" stroke="#222" stroke-width="1.4" stroke-linecap="round"/>',
        'modes':      '<circle cx="12" cy="12" r="7.5" stroke="#222" stroke-width="1.6"/><path d="M12 5v7l5 2.5" stroke="#222" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>',
        'wifi':       '<path d="M5 10a12 12 0 0 1 14 0M7 13.5a8 8 0 0 1 10 0M9 17a4 4 0 0 1 6 0" stroke="#222" stroke-width="1.8" stroke-linecap="round"/><circle cx="12" cy="20" r="1.4" fill="#222"/>'
      };
      var RIGHT_SVGS = {
        'refresh':  '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" style="color:var(--text-primary,#fff);"><path d="M4 12a8 8 0 0 1 14-5l2-2M20 7v4h-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        'chevron':  '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" style="color:var(--text-primary,#fff);"><path d="M9 6l6 6-6 6" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>'
      };
      var leftSvg = LEFT_SVGS[cpIcon] || LEFT_SVGS['smartthings'];
      var rightBlock = '';
      if (cpRight && RIGHT_SVGS[cpRight]) {
        rightBlock = '<div style="width:44px;height:44px;border-radius:50%;background:rgba(180,180,180,0.2);display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-left:8px;">' + RIGHT_SVGS[cpRight] + '</div>';
      }
      return '<div style="width:100%;height:100%;min-height:64px;' + _G('panel') + 'border-radius:36px;padding:10px 14px 10px 10px;box-sizing:border-box;display:flex;align-items:center;gap:12px;color:var(--text-primary,#fff);font-family:var(--font);">' +
        '<div style="width:44px;height:44px;border-radius:50%;background:#d5d5d5;flex-shrink:0;display:flex;align-items:center;justify-content:center;">' +
          '<svg width="24" height="24" viewBox="0 0 24 24" fill="none">' + leftSvg + '</svg>' +
        '</div>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:2px;overflow:hidden;">' +
          '<div style="font-size:14px;font-weight:600;line-height:1.2;">' + cpTitle + '</div>' +
          (cpSub ? '<div style="font-size:11px;line-height:1.3;opacity:0.75;">' + cpSub + '</div>' : '') +
        '</div>' +
        rightBlock +
      '</div>';
    }

    case 'media-output-row': {
      // "♪ Play music                     Media output"  label row
      // used in QS compact/minimal above the Smart View / Song Search tiles.
      var mor = (comp && comp.variant) || {};
      var morL = mor.left  || 'Play music';
      var morR = mor.right || 'Media output';
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:space-between;padding:0 16px;box-sizing:border-box;color:var(--text-primary,#fff);font-family:var(--font);font-size:13px;">' +
        '<div style="display:flex;align-items:center;gap:8px;"><span style="opacity:0.85;">\u266B</span><span>' + morL + '</span></div>' +
        '<div style="opacity:0.85;">' + morR + '</div>' +
      '</div>';
    }

    case 'qs-action-tile': {
      // Pill tile used for "Smart View / Mirror screen" and "Song Search"
      // at the bottom of QS. Left circular icon badge + 2-line text.
      var qat = (comp && comp.variant) || {};
      var qatIcon = qat.icon || 'smart-view';
      var qatTitle = qat.title || 'Smart View';
      var qatSub   = qat.sub || 'Mirror screen';
      var ICON_SVGS = {
        'smart-view':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><rect x="3" y="5" width="18" height="12" rx="1.5" stroke="#222" stroke-width="1.6"/><path d="M12 9l4 2.5-4 2.5V9z" fill="#222"/></svg>',
        'song-search':'<svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M9 17V6l10-2v11" stroke="#222" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/><circle cx="7" cy="17" r="2.4" stroke="#222" stroke-width="1.6"/><circle cx="17" cy="15" r="2.4" stroke="#222" stroke-width="1.6"/></svg>'
      };
      var qatSvg = ICON_SVGS[qatIcon] || ICON_SVGS['smart-view'];
      return '<div style="width:100%;height:100%;min-height:56px;' + _G('panel') + 'border-radius:32px;padding:8px 14px 8px 8px;box-sizing:border-box;display:flex;align-items:center;gap:10px;color:var(--text-primary,#fff);font-family:var(--font);">' +
        '<div style="width:40px;height:40px;border-radius:50%;background:#d5d5d5;flex-shrink:0;display:flex;align-items:center;justify-content:center;">' + qatSvg + '</div>' +
        '<div style="flex:1;min-width:0;display:flex;flex-direction:column;gap:1px;overflow:hidden;">' +
          '<div style="font-size:13px;font-weight:600;line-height:1.2;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + qatTitle + '</div>' +
          '<div style="font-size:11px;line-height:1.3;opacity:0.75;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">' + qatSub + '</div>' +
        '</div>' +
      '</div>';
    }

    case 'app-dock': {
      // Samsung Home dock — real PNG app icons, label-less.
      var dc = (comp && comp.content) || {};
      var defaultApps = ['Phone', 'Messages', 'Internet', 'Camera'];
      var apps = Array.isArray(dc.apps) ? dc.apps : defaultApps;

      function dockIconHTML(appName) {
        // Map label → filename in /app-icons/. Falls back to a glyph tile.
        var map = {
          'Phone':'Phone.png', 'Messages':'Messages.png', 'Internet':'Internet.png',
          'Camera':'Camera.png', 'Gallery':'Gallery.png', 'Contacts':'Contacts.png',
          'Settings':'Settings.png', 'Clock':'Clock.png', 'Weather':'Weather.png',
          'Calculator':'Calculator.png', 'Calendar':'Clock.png', 'Notes':'Notes.png',
          'Cloud':'Cloud.png', 'Health':'Health.png', 'Reminder':'Reminder.png',
          'Store':'Store.png', 'SmartThings':'SmartThings.png'
        };
        var file = map[appName] || null;
        if (file) {
          return '<img src="app-icons/' + file + '" style="width:56px;height:56px;border-radius:16px;object-fit:cover;flex-shrink:0;">';
        }
        var glyph = (appName || '·').charAt(0).toUpperCase();
        return '<div style="width:56px;height:56px;border-radius:16px;background:var(--accent-primary,#4285F4);display:flex;align-items:center;justify-content:center;flex-shrink:0;line-height:1;' +
          _T('heading', { weight: 'bold' }) + '">' + glyph + '</div>';
      }

      var iconsHTML = apps.slice(0, 5).map(dockIconHTML).join('');
      return '<div style="width:100%;height:100%;border-radius:var(--card-radius,' + _R('widget') + ');' +
        _G('widgetPill') +
        'display:flex;align-items:center;justify-content:space-around;padding:0 12px;box-sizing:border-box;">' +
        iconsHTML +
      '</div>';
    }

    case 'bottom-bar': {
      var bbc = (comp && comp.content) || {};
      var actions = Array.isArray(bbc.actions) ? bbc.actions : [{ label: 'Back' }, { label: 'Save' }, { label: 'Share' }];

      function barIconFor(label) {
        var lc = (label || '').toLowerCase();
        var c = 'currentColor';
        var s = 'width="16" height="16" viewBox="0 0 24 24" fill="none"';
        if (/back|cancel|close/.test(lc)) return '<svg ' + s + '><path d="M15 6l-6 6 6 6" stroke="' + c + '" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (/save|bookmark/.test(lc))      return '<svg ' + s + '><path d="M6 4h12v16l-6-4-6 4V4z" stroke="' + c + '" stroke-width="1.7" stroke-linejoin="round"/></svg>';
        if (/share/.test(lc))              return '<svg ' + s + '><circle cx="18" cy="6" r="2" stroke="' + c + '" stroke-width="1.7"/><circle cx="6" cy="12" r="2" stroke="' + c + '" stroke-width="1.7"/><circle cx="18" cy="18" r="2" stroke="' + c + '" stroke-width="1.7"/><path d="M8 11l8-4M8 13l8 4" stroke="' + c + '" stroke-width="1.5"/></svg>';
        if (/done|confirm|ok|check/.test(lc))  return '<svg ' + s + '><path d="M5 12l5 5 9-11" stroke="' + c + '" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
        if (/delete|trash|remove/.test(lc))    return '<svg ' + s + '><path d="M4 6h16M9 6V4h6v2M6 6l1 14h10l1-14" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        if (/edit|pencil/.test(lc))           return '<svg ' + s + '><path d="M4 20l4-1 10-10-3-3L5 16l-1 4z" stroke="' + c + '" stroke-width="1.6" stroke-linejoin="round"/></svg>';
        if (/cart|buy|order/.test(lc))        return '<svg ' + s + '><path d="M4 5h2l2 12h11l2-8H7" stroke="' + c + '" stroke-width="1.7" stroke-linejoin="round"/></svg>';
        if (/like|heart|favor/.test(lc))      return '<svg ' + s + '><path d="M12 20s-7-4.4-7-10a4 4 0 0 1 7-2.6A4 4 0 0 1 19 10c0 5.6-7 10-7 10z" stroke="' + c + '" stroke-width="1.7" stroke-linejoin="round"/></svg>';
        return '';
      }

      var actHTML = actions.slice(0, 4).map(function (a) {
        var lbl = (a && (a.label || a.text)) || '';
        var icon = barIconFor(lbl);
        return '<div style="display:flex;align-items:center;gap:6px;color:#fff;">' +
          (icon ? '<span style="display:flex;align-items:center;line-height:0;">' + icon + '</span>' : '') +
          '<span style="' + _T('caption', { weight: 'semibold' }) + '">' + lbl + '</span>' +
        '</div>';
      }).join('');

      return '<div style="width:100%;height:100%;border-radius:var(--card-radius,' + _R('widget') + ');' +
        _G('widgetPill') +
        'display:flex;align-items:center;justify-content:space-around;padding:0 14px;box-sizing:border-box;">' +
        actHTML +
      '</div>';
    }

    case 'bottom-dialog':
      // Light surface — typography color override
      return '<div style="width:100%;height:100%;border-radius:' + _R('dialog') + ' ' + _R('dialog') + ' 0 0;background:#f1f1f4;color:#111;padding:' + _S('4xl') + ';box-sizing:border-box;">' +
        '<div style="' + _T('heading', { weight: 'bold', color: '#111' }) + '">Dialog header</div>' +
        '<div style="' + _T('label', { color: '#666' }) + 'margin-top:' + _S('md') + ';">Dialog description</div>' +
        '<div style="display:flex;justify-content:space-between;margin-top:24px;' + _T('body', { color: '#111' }) + '"><span>Action 1</span><span>Action 2</span></div>' +
      '</div>';

    case 'center-dialog':
      return '<div style="width:100%;height:100%;border-radius:' + _R('dialog') + ';background:#f1f1f4;color:#111;padding:' + _S('4xl') + ';box-sizing:border-box;">' +
        '<div style="' + _T('heading', { weight: 'bold', color: '#111' }) + '">Center dialog</div>' +
        '<div style="' + _T('label', { color: '#666' }) + 'margin-top:' + _S('md') + ';">Blocking or loading state</div>' +
      '</div>';

    case 'lock-time':
      // hero size, clock family (SamsungNrDefault-V6), bold
      return '<div style="width:100%;height:100%;display:flex;align-items:flex-start;' +
        _T('hero', { family: 'clock', weight: 'bold' }) +
      '">12:45</div>';

    case 'lock-date':
      return '<div style="width:100%;height:100%;display:flex;align-items:center;' +
        _T('heading', { color: 'translucentLabel' }) +
      '">Tue, Apr 20</div>';

    case 'lock-shortcuts':
      // shortcutCircle glass tier; radius via circle token
      return '<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:space-between;">' +
        '<div style="width:48px;height:48px;border-radius:50%;' + _G('shortcutCircle') + '"></div>' +
        '<div style="width:48px;height:48px;border-radius:50%;' + _G('shortcutCircle') + '"></div>' +
      '</div>';

    case 'quick-settings-panel':
      return A.QSScreen
        ? A.QSScreen()
        : '<div style="width:100%;height:100%;border-radius:' + _R('panel') + ' ' + _R('panel') + ' 0 0;' + _G('panel') + '"></div>';

    case 'background':
      return A.Background ? A.Background() : '';

    case 'scrim':
      return '<div style="width:100%;height:100%;background:rgba(0,0,0,0.42);"></div>';

    default:
      return '<div style="width:100%;height:100%;border-radius:16px;background:rgba(255,255,255,0.08);"></div>';
  }
};

window.renderSurfacePlan = function renderSurfacePlan(canvas, plan, layout) {
  canvas.innerHTML = '';
  canvas.dataset.rulesMode = '1';
  canvas.style.position = 'relative';
  canvas.style.display = 'block';
  canvas.style.width = layout.viewport.width + 'px';
  canvas.style.height = layout.viewport.height + 'px';
  canvas.style.padding = '0';
  canvas.style.gap = '0';
  canvas.style.overflow = 'hidden';

  for (const comp of plan.components) {
    const rect = window.resolveComponentRect(comp, layout, plan);
    const wrapper = document.createElement('div');
    wrapper.className = 'canvas-item surface-item';
    wrapper.id = comp.id;
    wrapper.dataset.role = comp.role;
    wrapper.setAttribute('data-role', comp.role);
    wrapper.dataset.nodeId = comp.id;

    wrapper.style.position = 'absolute';
    wrapper.style.left = rect.x + 'px';
    wrapper.style.top = rect.y + 'px';
    wrapper.style.width = rect.w + 'px';
    wrapper.style.height = rect.h + 'px';

    if (comp.role === 'background' || comp.role === 'scrim') {
      wrapper.style.pointerEvents = 'none';
    }

    // R2: information-priority "defer" components carry
    // visibility="collapsed" — they render but dimmed, non-interactive,
    // and slightly scaled so the user can tell at a glance this is
    // context (not a primary action). Full hide would lose continuity.
    if (comp.visibility === 'collapsed') {
      wrapper.classList.add('priority-collapsed');
    } else if (comp.visibility === 'hidden') {
      wrapper.style.display = 'none';
    }

    // R3-B: emphasis classes driven by the purpose-aware layout
    // dispatcher (_layoutForPurpose). Renderer just reflects the
    // decision — no further reasoning here.
    //   hero      : central dominant element of the purpose layout
    //   must      : matches informationPriority.must_show (subtle glow)
    //   action    : pinned action-row at bottom of continuity/modal
    //   secondary : above-dialog context / supporting info
    //   dim       : dimmed supporting items in hero_single
    if (comp._emphasis) {
      wrapper.classList.add('emphasis-' + comp._emphasis);
    }

    wrapper.innerHTML = window.renderAtomicForRole(comp, rect);

    // Expanded children (list-item, focus-block cells, paragraphs, etc.)
    // get drag-drop reorder handlers. Identified by presence of `_rect`
    // (pre-computed during container expansion).
    if (comp._rect && window.attachReorderHandlers) {
      window.attachReorderHandlers(wrapper, comp.id);
    }

    canvas.appendChild(wrapper);
  }
};

// ============================================================================
// Drag-drop reorder for grouped children (list-items, widget cells, paragraphs,
// notif cards, palette-added items in the same column).
// ============================================================================
window.attachReorderHandlers = function attachReorderHandlers(el, nodeId) {
  if (!el || el.dataset.reorderBound === '1') return;
  el.dataset.reorderBound = '1';
  el.setAttribute('draggable', 'true');

  el.addEventListener('dragstart', function (e) {
    e.stopPropagation();
    e.dataTransfer.setData('text/plain', nodeId);
    e.dataTransfer.effectAllowed = 'move';
    el.classList.add('dragging');
    // Suppress hover overlay during drag
    if (typeof window.setHoveredNode === 'function') window.setHoveredNode(null);
  });

  el.addEventListener('dragend', function () {
    el.classList.remove('dragging');
    document.querySelectorAll('.drag-insert-before, .drag-insert-after')
      .forEach(function (n) { n.classList.remove('drag-insert-before', 'drag-insert-after'); });
  });

  el.addEventListener('dragover', function (e) {
    // Only accept drops from other draggable same-column items
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'move';
    var rect = el.getBoundingClientRect();
    var mid = rect.top + rect.height / 2;
    el.classList.remove('drag-insert-before', 'drag-insert-after');
    if (e.clientY < mid) el.classList.add('drag-insert-before');
    else el.classList.add('drag-insert-after');
  });

  el.addEventListener('dragleave', function () {
    el.classList.remove('drag-insert-before', 'drag-insert-after');
  });

  el.addEventListener('drop', function (e) {
    e.preventDefault();
    e.stopPropagation();
    el.classList.remove('drag-insert-before', 'drag-insert-after');
    var sourceId = e.dataTransfer.getData('text/plain');
    if (!sourceId || sourceId === nodeId) return;
    if (window.DesignDoc && typeof window.DesignDoc.reorderInColumn === 'function') {
      window.DesignDoc.reorderInColumn(sourceId, nodeId);
    }
  });
};

// Render the given surface type into #canvas.
// Fires EXACTLY ONE DesignDoc subscribe event ('hydrate') at the end.
// Callers (scene buttons, agent fallback, skeleton loader) rely on this
// single-event contract so scene-inspector + interaction-overlay don't
// double-refresh.
window.generateSurfaceScenario = function generateSurfaceScenario(surfaceType) {
  const canvas = document.getElementById('canvas');
  if (!canvas) return;

  const viewport = { width: 451, height: 978 };
  const layout = window.createOneUILayout(viewport, surfaceType);
  const plan = window.composeSurfacePlan(surfaceType, layout);
  // Expand compositional roles into individual editable nodes.
  window.expandContainerComponents(plan, layout);
  window.renderSurfacePlan(canvas, plan, layout);

  // Single hydrate — emits one 'hydrate' event to subscribers.
  if (window.DesignDoc && typeof window.DesignDoc.hydrateFromPlan === 'function') {
    window.DesignDoc.hydrateFromPlan(plan, surfaceType);
  }
};

// ============================================================================
// Expandable app bar — 2-state snap logic (expanded / collapsed only)
// Per One UI guide: no resting mid-state. Threshold-based snap on scroll.
// ============================================================================

window.setExpandableAppBarState = function setExpandableAppBarState(el, state) {
  if (!el) return;
  const isExpanded = state === 'expanded';

  el.dataset.appBarState = isExpanded ? 'expanded' : 'collapsed';

  const title = el.querySelector('[data-appbar-title]') || el.firstElementChild;
  if (title) {
    title.style.transition = 'font-size 220ms cubic-bezier(0.2,0,0,1), transform 220ms cubic-bezier(0.2,0,0,1), opacity 220ms cubic-bezier(0.2,0,0,1)';
  }

  el.style.transition = 'height 220ms cubic-bezier(0.2,0,0,1), top 220ms cubic-bezier(0.2,0,0,1)';
  el.style.height = isExpanded ? '215px' : '56px';

  if (title) {
    title.style.fontSize = isExpanded ? '32px' : '20px';
    title.style.transform = isExpanded ? 'translateY(0)' : 'translateY(-2px)';
  }
};

window.enableExpandableAppBarSnap = function enableExpandableAppBarSnap(canvas, surfaceType) {
  if (!canvas) return;
  if (
    surfaceType !== (window.SURFACE_TYPES?.FIRST_DEPTH_LIST || 'first-depth-list') &&
    surfaceType !== (window.SURFACE_TYPES?.SECOND_DEPTH_DETAIL || 'second-depth-detail')
  ) return;

  const appBar = canvas.querySelector('[data-role="expandable-app-bar"], .canvas-item[data-role="expandable-app-bar"]');
  const scrollBody =
    canvas.querySelector('[data-role="list"]') ||
    canvas.querySelector('[data-role="detail-content"]') ||
    canvas.querySelector('.canvas-item[data-role="list"]') ||
    canvas.querySelector('.canvas-item[data-role="detail-content"]');

  if (!appBar || !scrollBody) return;
  if (appBar.dataset.snapBound === '1') return;

  appBar.dataset.snapBound = '1';
  appBar.dataset.appBarState = appBar.dataset.appBarState || 'expanded';

  scrollBody.style.overflowY = 'auto';
  scrollBody.style.webkitOverflowScrolling = 'touch';

  let ticking = false;
  let lastScrollTop = 0;

  function applySnap() {
    ticking = false;
    const st = scrollBody.scrollTop;
    const threshold = 48;

    if (st <= 0) {
      window.setExpandableAppBarState(appBar, 'expanded');
      lastScrollTop = st;
      return;
    }

    if (st > threshold) {
      window.setExpandableAppBarState(appBar, 'collapsed');
    } else {
      window.setExpandableAppBarState(appBar, 'expanded');
    }

    lastScrollTop = st;
  }

  scrollBody.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true;
      requestAnimationFrame(applySnap);
    }
  });

  scrollBody.addEventListener('touchend', () => {
    applySnap();
  });

  scrollBody.addEventListener('mouseup', () => {
    applySnap();
  });
};

// ============================================================================
//  Interact-mode delegated handlers for surface atomics
//  ---------------------------------------------------------------------------
//  Atomics (toggle-chip, slider-pill, etc.) are rendered as innerHTML strings,
//  which means per-element onclick can't easily survive re-renders from
//  composeSurfacePlan. Instead we delegate from document:
//    - Clicks only take effect when body.cmd-interact-mode is set
//    - We stopPropagation so the canvas click handler doesn't run selection
//  The handler is idempotent — bind once.
// ============================================================================
(function () {
  if (window._atomicInteractBound) return;
  window._atomicInteractBound = true;

  function _inInteractMode(e) {
    return !!(e && (e.metaKey || e.ctrlKey)) ||
           document.body.classList.contains('cmd-interact-mode');
  }

  // --- Toggle chip: click anywhere on the 56×56 circle flips on/off --------
  document.addEventListener('click', function (e) {
    if (!_inInteractMode(e)) return;
    var chip = e.target.closest('[data-toggle-chip]');
    if (!chip) return;
    e.stopPropagation();
    var on = chip.getAttribute('data-on') === '1';
    var next = !on;
    chip.setAttribute('data-on', next ? '1' : '0');
    chip.style.background = next ? '#d5d5d5' : 'rgba(180,180,180,0.2)';
    var onEl = chip.querySelector('[data-toggle-on]');
    var offEl = chip.querySelector('[data-toggle-off]');
    if (onEl) onEl.style.display = next ? 'inline-flex' : 'none';
    if (offEl) offEl.style.display = next ? 'none' : 'inline-flex';
  }, true);

  // --- Shortcut / navigation press animation -------------------------------
  // `[data-shortcut]` marks single-toggle kind='shortcut' and any other
  // Figma atomics that represent a navigation action (open another screen).
  // No state changes — just a quick press-ripple so the click feels real.
  document.addEventListener('click', function (e) {
    if (!_inInteractMode(e)) return;
    var btn = e.target.closest('[data-shortcut]');
    if (!btn) return;
    e.stopPropagation();
    btn.style.transform = 'scale(0.96)';
    btn.style.background = 'rgba(23,23,26,0.5)';
    setTimeout(function () {
      btn.style.transform = '';
      btn.style.background = '';
    }, 140);
  }, true);

  // --- Slider pill: pointer-drag updates fill in %. Works for both
  // horizontal and vertical orientations (data-orient="vertical").
  // Vertical fill grows bottom→top, so we invert the Y axis.
  var _drag = null;
  function _setPctFromPoint(pill, clientX, clientY) {
    var rect = pill.getBoundingClientRect();
    var vertical = pill.getAttribute('data-orient') === 'vertical';
    var raw;
    if (vertical) {
      // Invert: pointer near top = 100%, near bottom = 0%
      raw = 1 - (clientY - rect.top) / Math.max(1, rect.height);
    } else {
      raw = (clientX - rect.left) / Math.max(1, rect.width);
    }
    var pct = Math.round(Math.max(0, Math.min(1, raw)) * 100);
    pill.setAttribute('data-pct', String(pct));
    var fill = pill.querySelector('[data-slider-fill]');
    if (!fill) return;
    if (vertical) fill.style.height = pct + '%';
    else          fill.style.width  = pct + '%';
  }
  document.addEventListener('pointerdown', function (e) {
    if (!_inInteractMode(e)) return;
    var pill = e.target.closest('[data-slider-pill]');
    if (!pill) return;
    e.stopPropagation();
    e.preventDefault();
    _drag = pill;
    try { pill.setPointerCapture(e.pointerId); } catch (_) {}
    _setPctFromPoint(pill, e.clientX, e.clientY);
  }, true);
  document.addEventListener('pointermove', function (e) {
    if (!_drag) return;
    _setPctFromPoint(_drag, e.clientX, e.clientY);
  }, true);
  document.addEventListener('pointerup', function () { _drag = null; }, true);
  document.addEventListener('pointercancel', function () { _drag = null; }, true);
})();
