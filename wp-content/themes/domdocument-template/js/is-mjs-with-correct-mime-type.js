"use strict";

async function prepareFetches ()
{
	const promises = [];

	[
		'wp-content/themes/domdocument-template/js/modules/common.mjs',
		// '../wp-content/themes/domdocument-template/js/modules/common.mjs',
		'../../wp-content/themes/domdocument-template/js/modules/common.mjs',
		'/wp-content/themes/domdocument-template/js/modules/common.mjs',
	].forEach( function ( /** @type {String} */ endpoint )
	{
		promises.push(
			fetch( endpoint, {
				method: 'GET',
				credentials: 'omit',
				cache: 'no-store',
				referrerPolicy: 'no-referrer',
				redirect: 'follow',
				mode: 'cors'
			} ).then( ( /** @type {Response} */ response ) =>
			{
				if (
					response.ok
					&& response.status === 200
				) {
					return response.headers.get( 'content-type' );
				}
				throw new Error( 'Cannot fetch :(' );
			} ).then( function ( /** @type {String} */ contentType )
			{
				return contentType;
			} ).catch( function ( /** @type {Error|Response} */ error )
			{
				return Promise.reject( error );
			} )
		);
	} );

	return promises;
}

function reportProblemIntoDashboardTile ( /** @type {String} */ wrongContentType )
{

	/** @type {HTMLDivElement|null} */
	const rootElement = document.getElementById( 'varsAdminDdtDashboardWidget' );

	if ( rootElement ) {

		/** @type {HTMLDivElement|null} */
		const insideElement = rootElement.querySelector( '.inside' );

		if ( insideElement ) {

			/** @type {HTMLParagraphElement|null} */
			const thxElement = insideElement.firstElementChild;

			if ( thxElement ) {
				rootElement.appendChild( document.createElement( 'br' ) );

				/** @type {HTMLDivElement} */
				const errorWrapperElement = document.createElement( 'div' );

				errorTitleElement.classList.add( 'error' );

				/** @type {HTMLStrongElement} */
				const errorTitleElement = document.createElement( 'strong' );

				// @todo : vypsat chybu

			}
		}
	}
}
reportProblemIntoDashboardTile( 'application/ocet-stream' );

// const promises = await prepareFetches();
// Promise.any( promises ).then( ( /** @type {String} */ contentType ) =>
// {
// 	console.log( 'GG', contentType );
// } ).catch( ( /** @type {AggregateError} */ error ) =>
// {
// 	console.log( 'All fetches failed :(', error.constructor.name, error.message );
// } );
