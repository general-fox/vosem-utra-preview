<?php
declare(strict_types=1);
if (PHP_SAPI !== 'cli') { http_response_code(404); exit; }
ini_set('display_errors', '0');
umask(0077);
$stage = 'load_app';
$report = ['checkedAt'=>gmdate('c'), 'status'=>'error'];
$exitCode = 0;
try {
    require_once __DIR__.'/app/site.php';
    require_once __DIR__.'/app/password-reset-mail.php';
    $stage = 'mail_configuration';
    $mail = cafe_reset_mail(__DIR__, cafe_site_config(__DIR__));
    if (!$mail) throw new RuntimeException('Mail is not configured.');
    $stage = 'send_queue';
    $result = $mail->drain();
    $report += $result;
    $report['status'] = $result['failed'] > 0 ? 'send_failed' : 'ok';
    if ($result['failed'] > 0) $exitCode = 1;
} catch (Throwable $error) {
    $report['stage'] = $stage;
    $report['errors'] = [class_exists('CafeResetMail',false) && method_exists('CafeResetMail','diagnosticCode') ? CafeResetMail::diagnosticCode($error) : 'app_files_unavailable'=>1];
    $exitCode = 1;
}
try {
    // Keep the most recent failure visible even after the failed job expires.
    $path = __DIR__.'/auth-mail-status.json';
    $previous = CafeStorage::readJson($path, []);
    if (!empty($report['errors'])) $report['lastFailure'] = ['at'=>$report['checkedAt'],'errors'=>$report['errors']];
    elseif (is_array($previous['lastFailure'] ?? null)) $report['lastFailure'] = $previous['lastFailure'];
    CafeStorage::atomicJson($path, $report);
} catch (Throwable) { $report['statusFileWritten'] = false; $exitCode = 1; }
echo json_encode($report, JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR)."\n";
exit($exitCode);
