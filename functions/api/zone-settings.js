/**
* [2026-11-27] GET a POST /api/zone-settings – stav a změny vybraných voleb zóny Cloudflare (režim „Pod útokem“, ochrana
* před boty, pravidla WAF proti pingbackům, vývojový režim, vyčištění cache, HTTPS…) pro nástroj „Nastavení Cloudflare“
* ve WordPressu (šablona domdocument-template, Nástroje → Nastavení Cloudflare). Jen s platným tokenem podepsaným
* WordPressem (hlavička Authorization); změna, kterou token dovolí, je v tokenu. Logika a popis jsou
* ve functions/_lib/zone-settings.js. Nastavení: functions/README.md, „Nastavení zóny z WordPressu“.
*
* Soubor pochází ze šablony domdocument-template (static-export/repository/functions/), export ho kopíruje do repozitáře
* statického webu – upravovat ho ve šabloně.
*/

import { handleZoneSettingsRequest } from '../_lib/zone-settings.js';

export const onRequest = handleZoneSettingsRequest;
