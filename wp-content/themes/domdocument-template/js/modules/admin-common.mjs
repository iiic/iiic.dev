/** @type {HTMLScriptElement} */
const settingsElement = document.getElementById( 'multiple-images-settings' );

/** @type {Object | null} */
const settings = settingsElement ? JSON.parse( settingsElement.text ) : null;

/** @type {HTMLDivElement} */
const rootElement = document.getElementById( settings.rootElementId );

/** @type {HTMLAnchorElement} */
const addElement = rootElement.querySelector( '.add' );

/** @type {HTMLElement} */
const loadingElement = rootElement.querySelector( '.loading' );

/** @type {HTMLAnchorElement} */
const removeElement = rootElement.querySelector( '.remove' );

/** @type {HTMLInputElement} */
const inputElement = rootElement.querySelector( 'input' );

/** @type {HTMLDivElement} */
const canvasElement = rootElement.querySelector( '.canvas' );

/** @type {Object | null} */
let frame = null;

loadingElement.hidden = true;
addElement.hidden = false;

addElement.addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
{
	event.preventDefault();
	event.stopPropagation();

	/** @type {HTMLAnchorElement} */
	const addElement = event.target;

	if ( frame ) {
		frame.open();
		return true;
	}

	frame = wp.media.frames.file_frame = wp.media( {
		title: settings.frameTitle,
		button: {
			text: settings.frameButtonText
		},
		multiple: true
	} );

	frame.open();

	frame.on( 'select', function ()
	{
		const pictures = {};
		frame.state().get( 'selection' ).map(
			function ( { attributes: picture } )
			{

				/** @type {HTMLImageElement} */
				const img = document.createElement( 'IMG' );

				img.src = picture.sizes.medium.url;
				img.alt = picture.alt;
				img.width = 254;
				img.setAttribute( 'sizes', '(max-width: 254px) 100vw, 254px' );
				img.setAttribute( 'loading', 'lazy' );
				img.setAttribute( 'class', 'attachment-266x266 size-266x266' );
				img.setAttribute( 'srcset',
					picture.sizes.medium.url + ' ' + picture.sizes.medium.width + 'w '
					+ picture.sizes.thumbnail.url + ' ' + picture.sizes.thumbnail.width + 'w '
					+ picture.sizes.full.url + ' ' + picture.sizes.full.width + 'w'
				);
				pictures[ picture.id ] = img;
			} );

		const keys = Object.keys( pictures );
		if ( keys.length ) {
			removeElement.hidden = false;
			addElement.textContent = keys.length === 1 ? settings.changeThisImage : settings.changeThoseImages;
			inputElement.value = keys.join();
			while ( canvasElement.firstChild ) {
				canvasElement.removeChild( canvasElement.lastChild );
			}
			keys.forEach( function ( /** @type {Number} */ key )
			{
				canvasElement.appendChild( pictures[ key ] );
			} );
		}
	} );

	frame.on( 'open', function ()
	{

		/** @type {Object} */
		const selection = frame.state().get( 'selection' );

		if ( inputElement && inputElement.value ) {
			inputElement.value.split( ',' ).forEach( function ( /** @type {Number} */ id )
			{
				selection.add( wp.media.attachment( id ) );
			} );
		}
	} );

}, {
	capture: false,
	once: false,
	passive: false,
} );

removeElement.addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
{
	event.preventDefault();
	event.stopPropagation();

	/** @type {HTMLAnchorElement} */
	const removeElement = event.target;

	while ( canvasElement.firstChild ) {
		canvasElement.removeChild( canvasElement.lastChild );
	}
	inputElement.value = '';
	addElement.textContent = settings.addImages;
	removeElement.hidden = true;
}, {
	capture: false,
	once: false,
	passive: false,
} );

/// pokračovat zde… dát sem google serp snippet
