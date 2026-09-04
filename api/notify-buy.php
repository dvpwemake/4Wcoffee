<?php
/**
 * Silent buy/contact notice.
 * Destination mailbox is never returned to the browser.
 * Set FOURTHWAVE_NOTIFY_TO in the server environment.
 */
header('Content-Type: application/json; charset=utf-8');
header('X-Content-Type-Options: nosniff');
header('Referrer-Policy: same-origin');
header('Cache-Control: no-store');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    http_response_code(405);
    echo json_encode(['ok' => false]);
    exit;
}

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
    echo json_encode(['ok' => false]);
    exit;
}

$raw = file_get_contents('php://input');
if ($raw === false || strlen($raw) > 4000) {
    http_response_code(413);
    echo json_encode(['ok' => false]);
    exit;
}
$data = json_decode($raw, true);
if (!is_array($data)) {
    http_response_code(400);
    echo json_encode(['ok' => false]);
    exit;
}

$type = preg_replace('/[^a-z]/', '', strtolower((string)($data['type'] ?? 'buy')));
if ($type !== 'buy' && $type !== 'contact') {
    $type = 'buy';
}
$id = substr(preg_replace('/[^\w.\-]+/', '', (string)($data['id'] ?? '')), 0, 80);
$name = substr(strip_tags((string)($data['name'] ?? '')), 0, 160);
$url = substr(strip_tags((string)($data['url'] ?? '')), 0, 400);
$note = substr(strip_tags((string)($data['note'] ?? '')), 0, 400);
if ($url && !preg_match('#^https?://#i', $url)) {
    $url = '';
}

$ip = $_SERVER['REMOTE_ADDR'] ?? '0';
$rate_file = sys_get_temp_dir() . '/fourthwave-notify-' . hash('sha256', $ip);
$now = time();
$last = is_file($rate_file) ? (int)file_get_contents($rate_file) : 0;
if ($now - $last < 3) {
    http_response_code(429);
    echo json_encode(['ok' => true]);
    exit;
}
@file_put_contents($rate_file, (string)$now);

$to = getenv('FOURTHWAVE_NOTIFY_TO');
if (!$to && is_file(__DIR__ . '/config.local.php')) {
    $cfg = include __DIR__ . '/config.local.php';
    if (is_array($cfg) && !empty($cfg['to'])) {
        $to = $cfg['to'];
    }
}
if (!$to) {
    echo json_encode(['ok' => true]);
    exit;
}

$subject = $type === 'contact'
    ? 'Fourth Wave Coffee contact'
    : 'Fourth Wave Coffee buy click';
$body = "type: {$type}\nid: {$id}\nname: {$name}\nurl: {$url}\nnote: {$note}\nip_hash: " . hash('sha256', $ip) . "\n";
$headers = "Content-Type: text/plain; charset=UTF-8\r\nX-Content-Type-Options: nosniff";
@mail($to, $subject, $body, $headers);

echo json_encode(['ok' => true]);
