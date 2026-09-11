<?php
/**
 * Same-origin cover fetch for the editor.
 * GET ?url=https://article
 * Returns { ok, image } — og:image or first article-body image. Skips ads/banners/logos.
 */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Cache-Control: no-store');

$host = $_SERVER['HTTP_HOST'] ?? '';
$origin = $_SERVER['HTTP_ORIGIN'] ?? '';
$referer = $_SERVER['HTTP_REFERER'] ?? '';
$allowed = ['fourthwavecoffee.org', 'www.fourthwavecoffee.org', 'localhost', '127.0.0.1'];
$host_ok = false;
foreach ($allowed as $ok) {
    if (stripos($host, $ok) !== false || stripos($origin, $ok) !== false || stripos($referer, $ok) !== false) {
        $host_ok = true;
        break;
    }
}
if (!$host_ok) {
    http_response_code(403);
    echo json_encode(['ok' => false, 'error' => 'forbidden']);
    exit;
}

$src = $_GET['url'] ?? '';
if (!$src && ($_SERVER['REQUEST_METHOD'] ?? '') === 'POST') {
    $raw = file_get_contents('php://input');
    $j = json_decode($raw ?: '', true);
    if (is_array($j)) $src = $j['url'] ?? '';
}
$src = trim((string) $src);
if (!preg_match('#^https?://#i', $src) || strlen($src) > 2000) {
    http_response_code(400);
    echo json_encode(['ok' => false, 'error' => 'bad url']);
    exit;
}

function is_chrome($url, $extra = '') {
    $blob = strtolower($url . ' ' . $extra);
    return (bool) preg_match(
        '#adserver|adservice|/ads/|advert|banner|sponsor|doubleclick|googlesyndication|adnxs|taboola|outbrain|criteo|1x1|spacer|sprite|favicon|logo[-_/]|[-_/]logo|icon[-_/]|[-_/]icon|avatar|blank\.gif|pixel\.gif|data:image/gif#i',
        $blob
    );
}

function abs_url($src, $base) {
    $src = html_entity_decode(trim($src), ENT_QUOTES, 'UTF-8');
    if ($src === '' || strpos($src, 'data:') === 0) return '';
    if (strpos($src, '//') === 0) return 'https:' . $src;
    if (preg_match('#^https?://#i', $src)) return $src;
    $p = parse_url($base);
    if (!$p || empty($p['scheme']) || empty($p['host'])) return '';
    $origin = $p['scheme'] . '://' . $p['host'] . (isset($p['port']) ? ':' . $p['port'] : '');
    if (isset($src[0]) && $src[0] === '/') return $origin . $src;
    $dir = isset($p['path']) ? preg_replace('#/[^/]*$#', '/', $p['path']) : '/';
    return $origin . $dir . $src;
}

$ch = curl_init($src);
curl_setopt_array($ch, [
    CURLOPT_RETURNTRANSFER => true,
    CURLOPT_FOLLOWLOCATION => true,
    CURLOPT_MAXREDIRS => 5,
    CURLOPT_TIMEOUT => 12,
    CURLOPT_USERAGENT => 'FourthWaveCoffee/1.0 (+https://fourthwavecoffee.org/)',
    CURLOPT_HTTPHEADER => ['Accept: text/html,application/xhtml+xml'],
]);
$html = curl_exec($ch);
$code = (int) curl_getinfo($ch, CURLINFO_HTTP_CODE);
curl_close($ch);
if (!is_string($html) || $html === '' || $code >= 400) {
    http_response_code(502);
    echo json_encode(['ok' => false, 'error' => 'fetch failed']);
    exit;
}

$image = '';
if (preg_match('/property=["\']og:image(?::secure_url)?["\'][^>]+content=["\']([^"\']+)/i', $html, $m)
    || preg_match('/content=["\']([^"\']+)["\'][^>]+property=["\']og:image/i', $html, $m)
    || preg_match('/name=["\']twitter:image(?::src)?["\'][^>]+content=["\']([^"\']+)/i', $html, $m)) {
    $cand = html_entity_decode($m[1], ENT_QUOTES, 'UTF-8');
    if ($cand && !is_chrome($cand)) $image = $cand;
}

if ($image === '') {
    $body = preg_replace('#<(script|style|header|nav|footer|aside|form)\b[^>]*>.*?</\1>#is', ' ', $html);
    if (preg_match_all('#<(article|main)\b[^>]*>.*?</\1>#is', $body, $blocks) && $blocks[0]) {
        $hay = implode("\n", $blocks[0]);
    } else {
        $hay = $body;
    }
    if (preg_match_all('#<img\b([^>]*?)src=["\']([^"\']+)["\']([^>]*)>#i', $hay, $imgs, PREG_SET_ORDER)) {
        foreach ($imgs as $im) {
            $tag = $im[0];
            $u = abs_url($im[2], $src);
            if ($u && !is_chrome($u, $tag)) {
                $image = $u;
                break;
            }
        }
    }
}

echo json_encode(['ok' => $image !== '', 'image' => $image]);
