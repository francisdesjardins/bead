// ── DevTools page ─────────────────────────────────────────────────────────────

// What DevTools loads of the extension as it opens on a tab: the Bead panel, beside the others.

// dependencies

import { chromeOf } from './api';

// constants

/**
 * The panel's tab: its name, then Bead's mark as a character, ⦿, since a panel's tab holds text
 * alone; no emoji presentation, so it takes the tab's own colour.
 */
export const PANEL_TITLE = 'Bead ⦿';

/** The icon `panels.create` names, the extension's 16 px one, for the browsers that draw it. */
const PANEL_ICON = 'icons/icon-16.png';

// definition

chromeOf().devtools?.panels.create(PANEL_TITLE, PANEL_ICON, 'panel.html');
