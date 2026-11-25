/*
	[2026-11-24] Nastavení HTML linteru html-validate pro statický web (https://html-validate.org/rules/).
	Soubor pochází ze šablony domdocument-template (static-export/repository/.site-checks/), export ho kopíruje do
	repozitáře statického webu – upravovat ho ve šabloně.

	Základ je doporučená sada pravidel: chyba (error) zastaví commit i zveřejnění na GitHubu, upozornění (warn) se jen vypíše.
	Spouští ho .site-checks/check-site.php (přes run-html-validate.mjs). Nález, který nejde opravit hned (typicky HTML v textu
	článku), jde přeskočit v .site-checks/ignore.txt – viz .site-checks/README.md.
*/
export default {
	extends: [ 'html-validate:recommended' ],
	rules: {
		// Styl zápisu, ne chyba: DOMDocument (saveHTML) píše logické atributy s prázdnou hodnotou – itemscope="", hidden="".
		'attribute-boolean-style': 'off',
		'attribute-empty-style': 'off',
		// HTML5 dovoluje v id cokoli kromě mezer. WordPress do id nadpisů dává zakódovanou diakritiku (co-je-nov%c3%a9ho).
		'valid-id': [ 'error', { relaxed: true } ],
		// [2026-11-25] Pravidla wcag/h30, element-permitted-content, attribute-misuse, unique-landmark, prefer-native-element
		// a no-implicit-button-type byla od 2026-11-24 jen upozornění. Chyby šablony jsou opravené (README.md šablony, „Změny
		// a opravy“), takže platí znovu jako chyby podle doporučené sady.
	},
};
