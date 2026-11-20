'use strict';

const sspScript = document.getElementById( 'ssp-script' );
sspScript.addEventListener( 'load', function ( /** @type {Event} */ event )
{

	const AD_PREFIX = 'szn-ssp';
	const SHOW_POPUP = 'show';
	const COMPLETED_POPUP = 'completed';

	let source = '';
	let keywords = '';
	let collocation = '';
	const adsList = [];

	if ( 'URLSearchParams' in window ) {
		const usp = new URLSearchParams( window.location.search );
		source = usp.get( 'utm_medium' );
		if ( usp.get( 'utm_source' ) === 'www.seznam.cz' && !document.cookie.includes( 'popupAd=' + COMPLETED_POPUP ) ) {
			var now = new Date();
			now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
			document.cookie = 'popupAd=' + SHOW_POPUP + ';expires=' + now.toUTCString() + ';path=/;SameSite=Lax';
		}
	}

	const semanticsString = document.getElementsByClassName( 'yoast-schema-graph yoast-schema-graph--main' );
	if ( semanticsString && semanticsString[ 0 ] ) {
		const semantics = JSON.parse( semanticsString[ 0 ].textContent );
		Array.prototype.slice.call( semantics[ '@graph' ] ).forEach( function ( /** @type {Object} */ item )
		{
			if ( item[ '@type' ] === 'Article' ) {
				keywords = item.keywords;
			} else if ( item[ '@type' ] === 'BreadcrumbList' ) {
				const wl = window.location;
				const breadcrumbs = item.itemListElement;
				const bcUrl = breadcrumbs[ ( breadcrumbs.length - 2 ) ].item.url;
				const prefix = wl.protocol + '//' + wl.hostname + '/category/';
				if ( bcUrl.includes( prefix ) ) {
					collocation = bcUrl.replace( prefix, '' );
					if ( collocation.slice( -1 ) === '/' ) {
						collocation = collocation.slice( 0, -1 );
					}
				}
			}
		} );
	}

	// const errorCallback = function ( /** @type {String} */ errorName, /** @type {Number} */ errorCode ) {
	// };

	sssp.config( {
		test: 1,
		version: 'v1',
		protocol: 'https://',
		server: 'ssp.imedia.cz',
		source: source, //"", "hp_feed", "novinky_feed", ...
		documentWriteOverride: true,
		// preparePositionsCallback: showAdContainers,
		//requestErrorCallback: errorCallback,
	} );

	// const singleAdCallback = ( /** @type {Object} */ ad, /** @type {Object} */ settings) => {
	// };

	// const singleAdError = (position, errorMessage) => {
	// };

	const singleAdOptions = {
		//infoCallback: singleAdCallback,
		//infoErrorCallback: singleAdError,
	};

	if ( 'assign' in Object ) {
		if ( keywords ) {
			Object.assign( singleAdOptions, { section: keywords } );
		}
		if ( collocation ) {
			Object.assign( singleAdOptions, { collocation: collocation } );
		}
	}

	if ( window.innerWidth >= 600 ) { // desktop
		const ads = [
			{ zoneId: 204341, id: AD_PREFIX + '-leaderboard', width: 970, height: 210, options: singleAdOptions },
			{ zoneId: 204346, id: AD_PREFIX + '-smr', width: 300, height: 300, options: singleAdOptions },
			{ zoneId: 204351, id: AD_PREFIX + '-sky', width: 300, height: 600, options: singleAdOptions },
			{ zoneId: 204361, id: AD_PREFIX + '-subarticle', width: 480, height: 300, options: singleAdOptions },
			{ zoneId: 204366, id: AD_PREFIX + '-rectangle', width: 970, height: 310, options: singleAdOptions },
		];
		ads.forEach( function ( /** @type {Object} */ ad )
		{
			adsList.push( ad );
		} );
		sssp.getAds( ads );
	} else { // mobile

		if ( document.cookie.includes( 'popupAd=' + SHOW_POPUP ) ) {
			var now = new Date();
			now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
			document.cookie = 'popupAd=' + SHOW_POPUP + ';expires=' + now.toUTCString() + ';path=/;SameSite=Lax';

			/** @type {HTMLDialogElement | null} */
			let dialog = document.getElementById( AD_PREFIX + '-popup' ).parentNode.parentNode;

			const breakpoint = document.querySelector( '.default-wp-page.clearfix' ).offsetTop;

			window.addEventListener( 'scroll', function ( /** @type {Event} */ )
			{
				if ( window.scrollY > breakpoint && dialog && !dialog.open ) {
					dialog.show();
					window.requestAnimationFrame( function ()
					{
						const popupAd = { zoneId: 204391, id: AD_PREFIX + '-popup', width: 320, height: 100, options: singleAdOptions };
						adsList.push( popupAd );
						sssp.getAds( popupAd );
					} );
					var now = new Date();
					now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
					document.cookie = 'popupAd=' + COMPLETED_POPUP + ';expires=' + now.toUTCString() + ';path=/;SameSite=Lax';
				}
			} );

			dialog.querySelector( 'button' ).addEventListener( 'click', function ( /** @type {MouseEvent} */ event )
			{
				dialog.close();
				dialog = null;
			}, false );
		}
		const ads = [
			{ zoneId: 204371, id: AD_PREFIX + '-subperex', width: 480, height: 480, options: singleAdOptions },
			{ zoneId: 204376, id: AD_PREFIX + '-text', width: 480, height: 480, options: singleAdOptions },
			{ zoneId: 204381, id: AD_PREFIX + '-subarticle', width: 480, height: 480, options: singleAdOptions },
			{ zoneId: 204386, id: AD_PREFIX + '-sky', minWidth: 300, width: 480, minHeight: 250, height: 480, options: singleAdOptions },
		];
		ads.forEach( function ( /** @type {Object} */ ad )
		{
			adsList.push( ad );
		} );
		sssp.getAds( ads );
	}

	adsList.forEach( function ( /** @type {Object} */ ad )
	{

		/** @type {HTMLDivElement} */
		const element = document.getElementById( ad.id );

		if ( element ) {
			element.style.boxShadow = 'inset 0 0 0 4px red';
			let width = ad.minWidth || ad.width || 200;
			const height = ad.minHeight || ad.height || 200;
			setTimeout( function ()
			{
				if ( element.offsetWidth < width ) {
					width = element.offsetWidth;
				}
				element.style.minWidth = width + 'px';
				element.style.minHeight = height + 'px';
			}, Math.round( Math.random() * 9999 ) );
		}
	} );

}, false );
