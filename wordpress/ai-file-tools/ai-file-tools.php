<?php
/**
 * Plugin Name:       AI File Tools — Image, PDF & Passport Photo Suite
 * Plugin URI:        https://github.com/contactmhcircle-create/invoice
 * Description:       Free, unlimited, in-browser file tools: image compressor (target file size — shrink OR grow), crop, sharpen, resize, format converters (JPG/PNG/WebP/HEIC), image↔PDF, PDF compress/merge/split/rotate, and an AI passport-photo maker that builds a clean formal photo from 4–5 casual pictures. All processing happens in the visitor's browser — nothing is uploaded to your server, so it costs nothing to run and works with any theme.
 * Version:           1.0.0
 * Author:            MH Circle
 * License:           GPL-2.0-or-later
 * Text Domain:       ai-file-tools
 */

if ( ! defined( 'ABSPATH' ) ) {
	exit;
}

define( 'AFT_VERSION', '1.0.0' );
define( 'AFT_URL', plugin_dir_url( __FILE__ ) );
define( 'AFT_PATH', plugin_dir_path( __FILE__ ) );

/**
 * Every tool the plugin ships. slug => [ shortcode, page title, description shown on the tools grid ]
 */
function aft_tools() {
	return array(
		'image-compress'  => array( 'aft_image_compress', __( 'Image Compressor & Resizer', 'ai-file-tools' ), __( 'Compress images, or hit an exact target file size — shrink or increase (great for forms that demand e.g. 20 KB–1 MB).', 'ai-file-tools' ) ),
		'image-crop'      => array( 'aft_image_crop', __( 'Image Cropper', 'ai-file-tools' ), __( 'Crop freely or to presets (square, 4:3, 16:9, passport 35×45).', 'ai-file-tools' ) ),
		'image-sharpen'   => array( 'aft_image_sharpen', __( 'Image Sharpener & Enhancer', 'ai-file-tools' ), __( 'Sharpen blurry photos, fix brightness, contrast and saturation.', 'ai-file-tools' ) ),
		'image-convert'   => array( 'aft_image_convert', __( 'Image Converter', 'ai-file-tools' ), __( 'JPG ↔ PNG ↔ WebP ↔ BMP, plus HEIC → JPG. Batch supported.', 'ai-file-tools' ) ),
		'image-to-pdf'    => array( 'aft_image_to_pdf', __( 'Image to PDF', 'ai-file-tools' ), __( 'Combine one or many images into a single PDF, with page size options.', 'ai-file-tools' ) ),
		'pdf-to-image'    => array( 'aft_pdf_to_image', __( 'PDF to Images', 'ai-file-tools' ), __( 'Turn every PDF page into a JPG or PNG. Download one by one or as ZIP.', 'ai-file-tools' ) ),
		'pdf-compress'    => array( 'aft_pdf_compress', __( 'PDF Compressor', 'ai-file-tools' ), __( 'Compress a PDF, or force an exact target size — smaller or bigger.', 'ai-file-tools' ) ),
		'pdf-merge'       => array( 'aft_pdf_merge', __( 'PDF Merge', 'ai-file-tools' ), __( 'Join multiple PDFs into one, in the order you choose.', 'ai-file-tools' ) ),
		'pdf-split'       => array( 'aft_pdf_split', __( 'PDF Split & Extract', 'ai-file-tools' ), __( 'Extract a page range, or split a PDF into separate pages.', 'ai-file-tools' ) ),
		'pdf-rotate'      => array( 'aft_pdf_rotate', __( 'PDF Rotate', 'ai-file-tools' ), __( 'Rotate all pages or selected pages by 90°, 180° or 270°.', 'ai-file-tools' ) ),
		'passport-photo'  => array( 'aft_passport_photo', __( 'AI Passport Photo Maker', 'ai-file-tools' ), __( 'Upload 4–5 casual photos — AI picks the sharpest face, cuts the background to plain white/blue, and crops to official passport size. Print sheet included.', 'ai-file-tools' ) ),
	);
}

/* -------------------------------------------------------------------------
 * Assets
 * ---------------------------------------------------------------------- */

function aft_register_assets() {
	wp_register_style( 'aft-css', AFT_URL . 'assets/css/aft.css', array(), AFT_VERSION );
	wp_register_script( 'aft-core', AFT_URL . 'assets/js/aft-core.js', array(), AFT_VERSION, true );
	wp_register_script( 'aft-image', AFT_URL . 'assets/js/aft-image.js', array( 'aft-core' ), AFT_VERSION, true );
	wp_register_script( 'aft-pdf', AFT_URL . 'assets/js/aft-pdf.js', array( 'aft-core' ), AFT_VERSION, true );
	wp_register_script( 'aft-passport', AFT_URL . 'assets/js/aft-passport.js', array( 'aft-core' ), AFT_VERSION, true );

	wp_localize_script(
		'aft-core',
		'AFT_CFG',
		array(
			'accent' => get_option( 'aft_accent_color', '#2563eb' ),
			'cdn'    => array(
				'cropperJs'    => 'https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.js',
				'cropperCss'   => 'https://cdn.jsdelivr.net/npm/cropperjs@1.6.2/dist/cropper.min.css',
				'jspdf'        => 'https://cdn.jsdelivr.net/npm/jspdf@2.5.2/dist/jspdf.umd.min.js',
				'pdfLib'       => 'https://cdn.jsdelivr.net/npm/pdf-lib@1.17.1/dist/pdf-lib.min.js',
				'pdfjs'        => 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.min.js',
				'pdfjsWorker'  => 'https://cdn.jsdelivr.net/npm/pdfjs-dist@3.11.174/build/pdf.worker.min.js',
				'heic2any'     => 'https://cdn.jsdelivr.net/npm/heic2any@0.0.4/dist/heic2any.min.js',
				'fflate'       => 'https://cdn.jsdelivr.net/npm/fflate@0.8.2/umd/index.min.js',
				'faceDetect'   => 'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229/face_detection.js',
				'faceDetectBase' => 'https://cdn.jsdelivr.net/npm/@mediapipe/face_detection@0.4.1646425229/',
				'selfieSeg'    => 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/selfie_segmentation.js',
				'selfieSegBase' => 'https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation@0.1.1675465747/',
			),
			'i18n'   => array(
				'processing' => __( 'Processing…', 'ai-file-tools' ),
				'done'       => __( 'Done', 'ai-file-tools' ),
				'download'   => __( 'Download', 'ai-file-tools' ),
				'error'      => __( 'Something went wrong. Please try a different file.', 'ai-file-tools' ),
			),
		)
	);
}
add_action( 'wp_enqueue_scripts', 'aft_register_assets' );

/**
 * Enqueue only what a tool needs. Called from inside shortcode callbacks,
 * which is safe because our scripts print in the footer.
 */
function aft_enqueue_for( $bundle ) {
	wp_enqueue_style( 'aft-css' );
	wp_enqueue_script( 'aft-core' );
	wp_enqueue_script( 'aft-' . $bundle );
	$accent = get_option( 'aft_accent_color', '#2563eb' );
	wp_add_inline_style( 'aft-css', ':root{--aft-accent:' . sanitize_hex_color( $accent ) . ';}' );
}

/* -------------------------------------------------------------------------
 * Shortcodes
 * ---------------------------------------------------------------------- */

function aft_tool_container( $tool, $bundle ) {
	aft_enqueue_for( $bundle );
	return '<div class="aft-tool" data-aft-tool="' . esc_attr( $tool ) . '"><noscript><p>' .
		esc_html__( 'This tool needs JavaScript. Please enable it in your browser.', 'ai-file-tools' ) .
		'</p></noscript></div>';
}

add_shortcode( 'aft_image_compress', function () { return aft_tool_container( 'image-compress', 'image' ); } );
add_shortcode( 'aft_image_crop', function () { return aft_tool_container( 'image-crop', 'image' ); } );
add_shortcode( 'aft_image_sharpen', function () { return aft_tool_container( 'image-sharpen', 'image' ); } );
add_shortcode( 'aft_image_convert', function () { return aft_tool_container( 'image-convert', 'image' ); } );
add_shortcode( 'aft_image_to_pdf', function () { return aft_tool_container( 'image-to-pdf', 'image' ); } );
add_shortcode( 'aft_pdf_to_image', function () { return aft_tool_container( 'pdf-to-image', 'pdf' ); } );
add_shortcode( 'aft_pdf_compress', function () { return aft_tool_container( 'pdf-compress', 'pdf' ); } );
add_shortcode( 'aft_pdf_merge', function () { return aft_tool_container( 'pdf-merge', 'pdf' ); } );
add_shortcode( 'aft_pdf_split', function () { return aft_tool_container( 'pdf-split', 'pdf' ); } );
add_shortcode( 'aft_pdf_rotate', function () { return aft_tool_container( 'pdf-rotate', 'pdf' ); } );
add_shortcode( 'aft_passport_photo', function () { return aft_tool_container( 'passport-photo', 'passport' ); } );

/**
 * [aft_all_tools] — a landing grid linking to every tool page that exists.
 */
add_shortcode(
	'aft_all_tools',
	function () {
		wp_enqueue_style( 'aft-css' );
		$out = '<div class="aft-grid">';
		foreach ( aft_tools() as $slug => $def ) {
			$page = get_page_by_path( 'tools/' . $slug );
			if ( ! $page ) {
				$page = get_page_by_path( $slug );
			}
			$url  = $page ? get_permalink( $page ) : '#';
			$out .= '<a class="aft-card" href="' . esc_url( $url ) . '">'
				. '<h3>' . esc_html( $def[1] ) . '</h3>'
				. '<p>' . esc_html( $def[2] ) . '</p>'
				. '</a>';
		}
		$out .= '</div>';
		return $out;
	}
);

/* -------------------------------------------------------------------------
 * Admin: settings page + one-click page creation
 * ---------------------------------------------------------------------- */

add_action(
	'admin_menu',
	function () {
		add_menu_page(
			__( 'AI File Tools', 'ai-file-tools' ),
			__( 'AI File Tools', 'ai-file-tools' ),
			'manage_options',
			'ai-file-tools',
			'aft_admin_page',
			'dashicons-images-alt2',
			66
		);
	}
);

add_action(
	'admin_init',
	function () {
		register_setting( 'aft_settings', 'aft_accent_color', array( 'sanitize_callback' => 'sanitize_hex_color', 'default' => '#2563eb' ) );
	}
);

function aft_create_pages() {
	$parent = get_page_by_path( 'tools' );
	if ( ! $parent ) {
		$parent_id = wp_insert_post(
			array(
				'post_title'   => __( 'Free File Tools', 'ai-file-tools' ),
				'post_name'    => 'tools',
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '[aft_all_tools]',
			)
		);
	} else {
		$parent_id = $parent->ID;
	}
	foreach ( aft_tools() as $slug => $def ) {
		if ( get_page_by_path( 'tools/' . $slug ) ) {
			continue;
		}
		wp_insert_post(
			array(
				'post_title'   => $def[1],
				'post_name'    => $slug,
				'post_parent'  => $parent_id,
				'post_status'  => 'publish',
				'post_type'    => 'page',
				'post_content' => '[' . $def[0] . ']',
			)
		);
	}
	return $parent_id;
}

function aft_admin_page() {
	if ( ! current_user_can( 'manage_options' ) ) {
		return;
	}
	$notice = '';
	if ( isset( $_POST['aft_create_pages'] ) && check_admin_referer( 'aft_create_pages' ) ) {
		$parent_id = aft_create_pages();
		$notice    = '<div class="notice notice-success"><p>' .
			sprintf(
				/* translators: %s: link to the tools landing page */
				esc_html__( 'Tool pages created. Visit %s to see them.', 'ai-file-tools' ),
				'<a href="' . esc_url( get_permalink( $parent_id ) ) . '">' . esc_html__( 'the tools page', 'ai-file-tools' ) . '</a>'
			) . '</p></div>';
	}
	echo '<div class="wrap"><h1>' . esc_html__( 'AI File Tools', 'ai-file-tools' ) . '</h1>';
	echo wp_kses_post( $notice );

	echo '<h2>' . esc_html__( 'Quick start', 'ai-file-tools' ) . '</h2>';
	echo '<p>' . esc_html__( 'Click the button below to auto-create a page for every tool (under /tools/), plus a landing page listing them all. Or place any shortcode on a page yourself.', 'ai-file-tools' ) . '</p>';
	echo '<form method="post">';
	wp_nonce_field( 'aft_create_pages' );
	submit_button( __( 'Create all tool pages', 'ai-file-tools' ), 'primary', 'aft_create_pages' );
	echo '</form>';

	echo '<h2>' . esc_html__( 'Shortcodes', 'ai-file-tools' ) . '</h2><table class="widefat striped" style="max-width:760px"><thead><tr><th>' .
		esc_html__( 'Tool', 'ai-file-tools' ) . '</th><th>' . esc_html__( 'Shortcode', 'ai-file-tools' ) . '</th></tr></thead><tbody>';
	echo '<tr><td>' . esc_html__( 'All-tools landing grid', 'ai-file-tools' ) . '</td><td><code>[aft_all_tools]</code></td></tr>';
	foreach ( aft_tools() as $def ) {
		echo '<tr><td>' . esc_html( $def[1] ) . '</td><td><code>[' . esc_html( $def[0] ) . ']</code></td></tr>';
	}
	echo '</tbody></table>';

	echo '<h2>' . esc_html__( 'Appearance', 'ai-file-tools' ) . '</h2>';
	echo '<form method="post" action="options.php">';
	settings_fields( 'aft_settings' );
	echo '<label>' . esc_html__( 'Accent color', 'ai-file-tools' ) . ' <input type="color" name="aft_accent_color" value="' . esc_attr( get_option( 'aft_accent_color', '#2563eb' ) ) . '"></label> ';
	submit_button( __( 'Save', 'ai-file-tools' ) );
	echo '</form>';

	echo '<h2>' . esc_html__( 'Privacy & cost', 'ai-file-tools' ) . '</h2>';
	echo '<p>' . esc_html__( 'Every tool runs entirely in the visitor\'s browser. Files are never uploaded to your server — so the tools are free to operate at any traffic level, and user documents stay private.', 'ai-file-tools' ) . '</p>';
	echo '</div>';
}

register_activation_hook( __FILE__, 'aft_create_pages' );
