'use strict';

/** @type {HTMLScriptElement} */
const sspScript = document.getElementById( 'ssp-script' );

sspScript.addEventListener( 'load', function ( /** @type {Event} */ event )
{

	/** @type {HTMLScriptElement} */
	const settingsElement = document.getElementById( 'ad-settings' );

	/** @type {Object} */
	const settings = JSON.parse( settingsElement.text );

	if ( settings ) {

		const AD_POPUP_ID = 'AD-POPUP';
		const SHOW_POPUP = 'show';
		const COMPLETED_POPUP = 'completed';
		const MOBILE_BREAKPOINT = 600; // integer in px
		const COOKIE_SUFFIX = '; path=/; SameSite=Strict; secure';

		let source = '';

		const isScrolledOn = function ( /** @type {HTMLElement} */ element )
		{
			return window.scrollY + window.innerHeight > element.offsetTop;
		};

		const closeListener = function ( /** @type {HTMLDialogElement} */ dialog, /** @type {MouseEvent} */ event )
		{
			if ( dialog ) {
				dialog.close();
			}
		};

		const showDevelopmentBy = function (/** @type {Array} */ ads )
		{
			ads.forEach( function ( /** @type {Object} */ ad )
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
		}

		const managePopup = function ( /** @type {Object} */ ad )
		{
			if (
				( ad.isMobile === true || ( ad.isDesktop === true && window.innerWidth >= MOBILE_BREAKPOINT ) )
				&& document.cookie.includes( 'popupAd=' + SHOW_POPUP )
			) {
				var now = new Date();
				now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
				document.cookie = 'popupAd=' + SHOW_POPUP + ';expires=' + now.toUTCString() + COOKIE_SUFFIX;

				/** @type {HTMLDialogElement} */
				let dialog = document.getElementById( AD_POPUP_ID ).parentNode.parentNode;

				window.addEventListener( 'scroll', function ( /** @type {Event} */ event )
				{
					if ( isScrolledOn( document.getElementById( 'footer' ) ) && dialog && !dialog.open ) {
						dialog.show();
						dialog = null;
						window.requestAnimationFrame( function ()
						{
							sssp.getAds( ad );
						} );
						var now = new Date();
						now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
						document.cookie = 'popupAd=' + COMPLETED_POPUP + ';expires=' + now.toUTCString() + COOKIE_SUFFIX;
					}
				}, {
					capture: false,
					once: false,
					passive: true,
				} );
				dialog.querySelector( 'button' ).addEventListener( 'click', closeListener.bind( this, dialog ), {
					capture: false,
					once: true,
					passive: true,
				} );
			}
		};

		if ( 'URLSearchParams' in window ) {
			const usp = new URLSearchParams( window.location.search );
			source = usp.get( 'utm_medium' );
			if ( usp.get( 'utm_source' ) === 'www.seznam.cz' && !document.cookie.includes( 'popupAd=' + COMPLETED_POPUP ) ) {
				var now = new Date();
				now.setTime( now.getTime() + ( 30 * 60 * 1000 ) );
				document.cookie = 'popupAd=' + SHOW_POPUP + ';expires=' + now.toUTCString() + COOKIE_SUFFIX;
			}
		}

		// const errorCallback = function ( /** @type {String} */ errorName, /** @type {Number} */ errorCode ) {
		// };

		const ssspConfig = {
			version: 'v1',
			protocol: 'https://',
			server: 'ssp.imedia.cz',
			source: source, //"", "hp_feed", "novinky_feed", ...
			documentWriteOverride: true,
			// preparePositionsCallback: showAdContainers,
			//requestErrorCallback: errorCallback,
		};

		const singleAdOptions = {
			//infoCallback: singleAdCallback,
			//infoErrorCallback: singleAdError,
		};

		if ( 'assign' in Object ) {
			if ( settings.config.section ) {
				Object.assign( singleAdOptions, { section: settings.config.section } );
			}
			if ( settings.config.collocation ) {
				Object.assign( singleAdOptions, { collocation: settings.config.collocation } );
			}
			if ( settings.config.test ) {
				Object.assign( ssspConfig, { test: true } );
			}
		}

		sssp.config( ssspConfig );

		// const singleAdCallback = ( /** @type {Object} */ ad, /** @type {Object} */ settings) => {
		// };

		// const singleAdError = (position, errorMessage) => {
		// };

		const mobileAds = [];
		const desktopAds = [];
		settings.ads.forEach( function ( /** @type {Object} */ ad )
		{
			if ( ad.id === AD_POPUP_ID ) {
				managePopup( ad );
				if ( ssspConfig.test ) {
					showDevelopmentBy( [ ad ] );
				}
			} else {
				if ( !ad.options ) {
					ad.options = singleAdOptions;
				}
				if ( ad.isDesktop === true ) {
					desktopAds.push( ad );
				}
				if ( ad.isMobile === true ) {
					mobileAds.push( ad );
				}
				delete ad.isMobile;
				delete ad.isDesktop;
			}
		} );

		if ( window.innerWidth >= MOBILE_BREAKPOINT && desktopAds.length ) {
			sssp.getAds( desktopAds );
			if ( ssspConfig.test ) {
				showDevelopmentBy( desktopAds );
			}
		} else if ( mobileAds.length ) {
			sssp.getAds( mobileAds );
			if ( mobileAds.test ) {
				showDevelopmentBy( mobileAds );
			}
		}

	}

}, {
	capture: false,
	once: true,
	passive: true,
} );
