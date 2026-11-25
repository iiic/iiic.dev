// [2026-11-25] Spouští HTML linter html-validate pro .site-checks/check-site.php. Ten jeho nálezy vypíše spolu s ostatními
// kontrolami a přeskakuje je podle .site-checks/ignore.txt stejně jako svoje (kontroly html-validate a html-validate-upozorneni).
//
// Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), export ho kopíruje do repozitáře
// statického webu – upravovat ho ve šabloně.
//
// Vstup (stdin): cesty stránek HTML relativně k aktuální složce (kořen webu), jedna na řádek. Seznam dává check-site.php,
// takže se kontrolují stejné stránky (bez .git, .site-checks, node_modules…) a nehrozí limit délky příkazové řádky.
// Výstup (stdout): JSON { "version": "…", "messages": [ [ soubor, řádek, závažnost (2 = chyba, 1 = upozornění), pravidlo, zpráva, selektor ], … ] }
// Návratový kód je 0, i když html-validate něco našel. Jiný kód = html-validate nejde spustit (důvod je na stderr).
//
// Celý výpis přímo z html-validate (s ukázkou kódu u každého nálezu), v kořeni repozitáře:
//   node .site-checks/node_modules/html-validate/bin/html-validate.mjs --config .site-checks/htmlvalidate.mjs "**/*.html"

import { HtmlValidate, StaticConfigLoader, version } from 'html-validate';
import config from './htmlvalidate.mjs';

process.stdin.setEncoding( 'utf8' );
let input = '';
for await ( const chunk of process.stdin ) {
	input += chunk;
}

const htmlvalidate = new HtmlValidate( new StaticConfigLoader( config ) ); // jen toto nastavení, žádné .htmlvalidate.json ze složek webu
const messages = [];
for ( const file of input.split( /\r?\n/ ).filter( Boolean ) ) {
	const report = await htmlvalidate.validateFile( file );
	for ( const result of report.results ) {
		for ( const message of result.messages ) {
			messages.push( [ file, message.line, message.severity, message.ruleId, message.message, message.selector ?? '' ] );
		}
	}
}
process.stdout.write( JSON.stringify( { version, messages } ) );
