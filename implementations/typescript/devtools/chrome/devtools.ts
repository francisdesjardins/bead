// ── DevTools page ─────────────────────────────────────────────────────────────

// What DevTools loads of the extension as it opens on a tab: the Bead panel, beside the others.

// dependencies

import { chromeOf } from './api';

// constants

/**
 * The panel's tab: Bead's mark, then its name, as React's tabs carry theirs. Chrome draws no image
 * on a panel's tab, so the mark is a character, ⦿, the Moon's disc in the light at its edge, where
 * Baily's beads break through, in the tab's own text colour: no emoji presentation, and drawn by
 * Windows' default fonts.
 */
export const PANEL_TITLE = '⦿ Bead';

/** The icon `panels.create` names, the extension's 16 px one, for the browsers that draw it. */
const PANEL_ICON = 'icons/icon-16.png';

// definition

chromeOf().devtools?.panels.create(PANEL_TITLE, PANEL_ICON, 'panel.html');
