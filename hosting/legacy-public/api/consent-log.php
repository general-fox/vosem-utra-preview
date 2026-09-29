<?php
declare(strict_types=1);

const CONSENT_VERSION = '2026-09-29-reg5';

function consent_document_hash(string $document): string {
    if (!in_array($document, ['consent', 'privacy'], true)) throw new RuntimeException('consent_document_invalid');
    // Public HTML is routed through PHP in the REG.RU package. Keep the exact
    // versioned text outside the document root rather than hashing missing URLs.
    $file = dirname(__DIR__, 2).'/vosem-utra-private/legal-versions/'.CONSENT_VERSION.'/'.$document.'.html';
    $hash = is_file($file) ? hash_file('sha256', $file) : false;
    if (!is_string($hash)) throw new RuntimeException('consent_document_unavailable');
    return $hash;
}

function consent_directory(): string {
    $dir = dirname(__DIR__, 2).'/vosem-utra-private/consents';
    if (!is_dir($dir) && !@mkdir($dir,0700,true) && !is_dir($dir)) throw new RuntimeException('consent_storage_unavailable');
    return $dir;
}

function consent_key(): string {
    $file = consent_directory().'/audit.key';
    if (!is_file($file)) {
        $handle = @fopen($file,'x+b');
        if ($handle) {
            @chmod($file,0600);
            $key = random_bytes(32);
            if (fwrite($handle,$key) !== 32) { fclose($handle); throw new RuntimeException('consent_key_write'); }
            fflush($handle); fclose($handle);
        }
    }
    $key = @file_get_contents($file);
    if (!is_string($key) || strlen($key)!==32) throw new RuntimeException('consent_key_unavailable');
    return $key;
}

function consent_record(array $payload): string {
    $dir = consent_directory();
    $key = consent_key();
    $id = bin2hex(random_bytes(16));
    $record = [
        'id'=>$id, 'received_at'=>gmdate('c'), 'version'=>CONSENT_VERSION,
        'consent'=>true, 'captcha_permission'=>true,
        'consent_sha256'=>consent_document_hash('consent'),
        'privacy_sha256'=>consent_document_hash('privacy'),
        'phone_hmac'=>hash_hmac('sha256',$payload['Phone'],$key),
        'payload_hmac'=>hash_hmac('sha256',json_encode($payload,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR),$key),
        'status'=>'submitted',
    ];
    // No names, date of birth, phone, comment, IP or captcha token in the receipt.
    $file = $dir.'/'.$id.'.json';
    $data = json_encode($record,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
    if (@file_put_contents($file,$data,LOCK_EX)!==strlen($data)) throw new RuntimeException('consent_write_failed');
    @chmod($file,0600);
    return $id;
}

function consent_result(string $id, string $status): void {
    if (!preg_match('/^[a-f0-9]{32}$/D',$id)) return;
    try {
        $file = consent_directory().'/'.$id.'.json';
        $record = json_decode((string)@file_get_contents($file),true);
        if (!is_array($record)) throw new RuntimeException('consent_receipt_unavailable');
        $record['status'] = $status;
        $record['updated_at'] = gmdate('c');
        $data = json_encode($record,JSON_UNESCAPED_UNICODE|JSON_THROW_ON_ERROR);
        // Replace atomically: a failed status update must not destroy the receipt
        // or turn an already accepted registration into an unhandled HTTP error.
        $temp = $file.'.'.bin2hex(random_bytes(4)).'.tmp';
        if (@file_put_contents($temp,$data,LOCK_EX)!==strlen($data)) throw new RuntimeException('consent_status_write');
        @chmod($temp,0600);
        if (!@rename($temp,$file)) throw new RuntimeException('consent_status_replace');
    } catch (Throwable $e) {
        if (isset($temp) && is_file($temp)) @unlink($temp);
        error_log('Consent status update failed; original receipt remains.');
    }
}
