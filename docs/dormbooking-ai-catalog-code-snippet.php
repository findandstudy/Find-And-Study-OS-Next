<?php
/**
 * DormBooking AI Catalog REST endpoint.
 *
 * Install in WordPress Code Snippets as a PHP snippet (omit this opening PHP
 * tag when pasting). Run everywhere. The endpoint exposes only published,
 * student-facing dorm and room data:
 *   GET /wp-json/dormbooking/v1/ai-catalog?page=1&per_page=50
 */

if (!defined('ABSPATH')) {
    exit;
}

function dormbooking_ai_text($value) {
    if (!is_scalar($value)) {
        return '';
    }
    return trim(preg_replace('/\s+/u', ' ', wp_strip_all_tags((string) $value)));
}

function dormbooking_ai_meta($post_id, array $keys) {
    foreach ($keys as $key) {
        $value = get_post_meta($post_id, $key, true);
        if ($value !== '' && $value !== null && $value !== false) {
            return $value;
        }
    }
    return null;
}

function dormbooking_ai_number($value) {
    if ($value === null || $value === '') {
        return null;
    }
    $normalized = str_replace(array(',', ' '), '', (string) $value);
    return is_numeric($normalized) ? (float) $normalized : null;
}

function dormbooking_ai_terms($post_id, array $taxonomies) {
    $names = array();
    foreach ($taxonomies as $taxonomy) {
        if (!taxonomy_exists($taxonomy)) {
            continue;
        }
        $terms = wp_get_post_terms($post_id, $taxonomy, array('fields' => 'names'));
        if (!is_wp_error($terms)) {
            foreach ($terms as $term) {
                $safe = dormbooking_ai_text($term);
                if ($safe !== '') {
                    $names[] = $safe;
                }
            }
        }
    }
    return array_values(array_unique($names));
}

function dormbooking_ai_media_url($attachment_id) {
    $id = absint($attachment_id);
    if (!$id) {
        return null;
    }
    $url = wp_get_attachment_image_url($id, 'large');
    return $url ? esc_url_raw($url) : null;
}

function dormbooking_ai_gallery($post_id) {
    $raw = dormbooking_ai_meta($post_id, array('gallery', 'gallery_id', 'st_gallery', 'room_gallery'));
    if (is_string($raw)) {
        $raw = preg_split('/[,|]/', $raw);
    }
    if (!is_array($raw)) {
        return array();
    }
    $urls = array();
    foreach ($raw as $item) {
        $url = dormbooking_ai_media_url($item);
        if ($url) {
            $urls[] = $url;
        }
    }
    return array_values(array_unique($urls));
}

function dormbooking_ai_description($post) {
    $value = $post->post_excerpt !== '' ? $post->post_excerpt : $post->post_content;
    $text = dormbooking_ai_text(strip_shortcodes($value));
    $text = preg_replace('/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu', '[contact removed]', $text);
    $text = preg_replace('/\b(?:phone|telephone|tel|whatsapp|e-mail|email)\s*[:：-]?\s*\+?[\d\s().-]{7,}\d/iu', '[contact removed]', $text);
    return function_exists('mb_substr') ? mb_substr($text, 0, 12000) : substr($text, 0, 12000);
}

function dormbooking_ai_contract_date($description, $label) {
    if (!preg_match('/\b' . preg_quote($label, '/') . '\s*:\s*(\d{1,2})[\/.](\d{1,2})[\/.](\d{4})/iu', $description, $matches)) {
        return null;
    }
    $date = DateTimeImmutable::createFromFormat('!d/m/Y', sprintf('%02d/%02d/%04d', $matches[1], $matches[2], $matches[3]));
    return $date ? $date->format('Y-m-d') : null;
}

function dormbooking_ai_room($room_post) {
    $room_id = (int) $room_post->ID;
    $description = dormbooking_ai_description($room_post);
    return array(
        'id' => $room_id,
        'name' => dormbooking_ai_text(get_the_title($room_id)),
        'url' => esc_url_raw(get_permalink($room_id)),
        'modifiedAt' => get_post_modified_time(DATE_ATOM, true, $room_id),
        'description' => $description,
        'listedPrice' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('price'))),
        'currency' => 'USD',
        // Leave null unless the source explicitly stores a recognizable unit.
        // The consuming AI is instructed never to infer monthly/yearly terms.
        'priceBasis' => dormbooking_ai_text(dormbooking_ai_meta($room_id, array('price_unit', 'price_basis', 'unit'))) ?: null,
        // Reservation/holding payment is deliberately separate from the full
        // accommodation price. Only expose an explicitly stored value.
        'holdingFee' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('holding_fee', '_holding_fee', 'reservation_fee', 'booking_fee'))),
        'contractStart' => dormbooking_ai_text(dormbooking_ai_meta($room_id, array('contract_start', 'check_in'))) ?: null,
        'contractEnd' => dormbooking_ai_text(dormbooking_ai_meta($room_id, array('contract_end', 'check_out'))) ?: null,
        'instalmentPlan' => dormbooking_ai_text(dormbooking_ai_meta($room_id, array('instalment_plan', 'installment_plan', 'payment_plan'))) ?: null,
        'roomCount' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('number_room'))),
        'adults' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('adult_number'))),
        'children' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('children_number'))),
        'beds' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('bed_number'))),
        'bathrooms' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('bath_number'))),
        'areaSquareMeters' => dormbooking_ai_number(dormbooking_ai_meta($room_id, array('room_footage'))),
        'facilities' => dormbooking_ai_terms($room_id, array('room-facilities')),
        'image' => dormbooking_ai_media_url(get_post_thumbnail_id($room_id)),
        'gallery' => dormbooking_ai_gallery($room_id),
        'bookingMode' => dormbooking_ai_text(dormbooking_ai_meta($room_id, array('st_room_external_booking', 'room_external_booking'))) ?: null,
    );
}

function dormbooking_ai_dorm($dorm_post) {
    $dorm_id = (int) $dorm_post->ID;
    $description = dormbooking_ai_description($dorm_post);
    $room_query = new WP_Query(array(
        'post_type' => 'hotel_room',
        'post_status' => 'publish',
        'posts_per_page' => -1,
        'orderby' => array('menu_order' => 'ASC', 'title' => 'ASC'),
        'no_found_rows' => true,
        'meta_query' => array(array(
            'key' => 'room_parent',
            'value' => $dorm_id,
            'compare' => '=',
            'type' => 'NUMERIC',
        )),
    ));
    $rooms = array_map('dormbooking_ai_room', $room_query->posts);
    wp_reset_postdata();

    return array(
        'id' => $dorm_id,
        'name' => dormbooking_ai_text(get_the_title($dorm_id)),
        'url' => esc_url_raw(get_permalink($dorm_id)),
        'modifiedAt' => get_post_modified_time(DATE_ATOM, true, $dorm_id),
        'description' => $description,
        'address' => dormbooking_ai_text(dormbooking_ai_meta($dorm_id, array('address', 'hotel_address'))),
        'city' => dormbooking_ai_text(dormbooking_ai_meta($dorm_id, array('city'))) ?: 'Istanbul',
        'latitude' => dormbooking_ai_number(dormbooking_ai_meta($dorm_id, array('map_lat', 'latitude', 'lat'))),
        'longitude' => dormbooking_ai_number(dormbooking_ai_meta($dorm_id, array('map_lng', 'longitude', 'lng'))),
        'accommodationTypes' => dormbooking_ai_terms($dorm_id, array('accommodation-type', 'hotel-theme')),
        'facilities' => dormbooking_ai_terms($dorm_id, array('hotel-facilities')),
        'nearbyUniversities' => dormbooking_ai_terms($dorm_id, array('neard-university', 'near-university')),
        'rating' => dormbooking_ai_number(dormbooking_ai_meta($dorm_id, array('review_score', 'rate_review', 'rating'))),
        'averageListedPrice' => dormbooking_ai_number(dormbooking_ai_meta($dorm_id, array('price_avg', 'avg_price', 'price'))),
        'currency' => 'USD',
        // These values are rendered publicly as Check In / Check Out and are
        // the contractual accommodation period.
        'contractStart' => dormbooking_ai_contract_date($description, 'Check In'),
        'contractEnd' => dormbooking_ai_contract_date($description, 'Check Out'),
        'image' => dormbooking_ai_media_url(get_post_thumbnail_id($dorm_id)),
        'gallery' => dormbooking_ai_gallery($dorm_id),
        'rooms' => $rooms,
    );
}

function dormbooking_ai_catalog_endpoint(WP_REST_Request $request) {
    $page = max(1, absint($request->get_param('page')));
    $per_page = min(50, max(1, absint($request->get_param('per_page')) ?: 50));
    $query = new WP_Query(array(
        'post_type' => 'st_hotel',
        'post_status' => 'publish',
        'paged' => $page,
        'posts_per_page' => $per_page,
        'orderby' => array('modified' => 'DESC', 'ID' => 'ASC'),
    ));

    $payload = array(
        'success' => true,
        'dorms' => array_map('dormbooking_ai_dorm', $query->posts),
        'pagination' => array(
            'page' => $page,
            'perPage' => $per_page,
            'total' => (int) $query->found_posts,
            'totalPages' => max(1, (int) $query->max_num_pages),
        ),
    );
    wp_reset_postdata();

    $response = new WP_REST_Response($payload, 200);
    $response->header('Cache-Control', 'public, max-age=300, stale-while-revalidate=600');
    $response->header('ETag', '"' . hash('sha256', wp_json_encode($payload)) . '"');
    return $response;
}

add_action('rest_api_init', function () {
    register_rest_route('dormbooking/v1', '/ai-catalog', array(
        'methods' => WP_REST_Server::READABLE,
        'callback' => 'dormbooking_ai_catalog_endpoint',
        'permission_callback' => '__return_true',
        'args' => array(
            'page' => array('sanitize_callback' => 'absint', 'default' => 1),
            'per_page' => array('sanitize_callback' => 'absint', 'default' => 50),
        ),
    ));
});
