/**
* [2026-11-27] GET /api/dashboard/referrers – odkazující weby (zpětné odkazy) z HTTP požadavků zóny a z Web Analytics pro
* stránku Analytická data ve WordPressu (šablona domdocument-template). Jen s platným tokenem podepsaným WordPressem
* (hlavička Authorization), logika a popis odpovědi jsou ve functions/_lib/dashboard-referrers.js.
* Nastavení: functions/README.md, „Údaje pro nástěnku WordPressu“.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { handleReferrersRequest } from '../../_lib/dashboard-referrers.js';

export const onRequest = handleReferrersRequest;
