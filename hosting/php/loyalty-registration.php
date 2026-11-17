<?php
declare(strict_types=1);

/** Durable, cross-session duplicate protection. No profile fields or plain phone numbers are stored. */
final class LoyaltyRegistration {
    private PDO $db;
    private string $key;
    public function __construct(private string $privateRoot, private string $origin) {
        $directory=$privateRoot.'/registration-data';
        if (!is_dir($directory) && !mkdir($directory,0700,true) && !is_dir($directory)) throw new RuntimeException('registration_storage_unavailable');
        // A dedicated stable key survives FlashCall/Flex API-key rotation. Lock before reading/writing it.
        $keyFile=$directory.'/hmac.key';
        if (is_file($directory.'/ledger.sqlite') && !is_file($keyFile)) throw new RuntimeException('registration_key_missing_for_existing_ledger');
        $handle=@fopen($keyFile,'c+b');
        if (!$handle) throw new RuntimeException('registration_key_unavailable');
        try {
            if (!flock($handle,LOCK_EX)) throw new RuntimeException('registration_key_lock');
            @chmod($keyFile,0600);
            $key=stream_get_contents($handle);
            if ($key==='') {
                if (is_file($directory.'/ledger.sqlite')) throw new RuntimeException('registration_key_empty_for_existing_ledger');
                $key=random_bytes(32);
                if (fwrite($handle,$key)!==32 || !fflush($handle)) throw new RuntimeException('registration_key_write');
            }
            if (!is_string($key) || strlen($key)!==32) throw new RuntimeException('registration_key_invalid');
            $this->key=$key;
        } finally { flock($handle,LOCK_UN); fclose($handle); }
        $this->db=new PDO('sqlite:'.$directory.'/ledger.sqlite',null,null,[PDO::ATTR_ERRMODE=>PDO::ERRMODE_EXCEPTION]);
        $this->db->exec('PRAGMA busy_timeout=5000');
        $this->db->exec('CREATE TABLE IF NOT EXISTS registrations (phone_key TEXT PRIMARY KEY, status TEXT NOT NULL, receipt TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL)');
        @chmod($directory.'/ledger.sqlite',0600);
    }
    private function phoneKey(string $phone): string {
        if (!preg_match('/^\+7[0-9]{10}$/D',$phone)) throw new RuntimeException('registration_phone_invalid');
        return hash_hmac('sha256',$this->origin.':'.$phone,$this->key);
    }
    /** Older site versions recorded only consent receipts. Import their result on first encounter. */
    private function legacyStatus(string $phone): ?array {
        $directory=$this->privateRoot.'/consents';
        if (!is_dir($directory)) return null;
        $files=[];
        foreach (new DirectoryIterator($directory) as $file) {
            if ($file->isFile() && preg_match('/^[a-f0-9]{32}\.json$/D',$file->getFilename())) $files[]=$file->getPathname();
        }
        if (!$files) return null;
        $key=@file_get_contents($directory.'/audit.key');
        if (!is_string($key) || strlen($key)!==32) throw new RuntimeException('legacy_consent_key_unavailable');
        $phoneKey=hash_hmac('sha256',$phone,$key); $found=null;
        foreach ($files as $file) {
            $raw=@file_get_contents($file);
            $record=is_string($raw) ? json_decode($raw,true) : null;
            if (!is_array($record) || ($record['id'] ?? '')!==pathinfo($file,PATHINFO_FILENAME)
                || !is_string($record['phone_hmac'] ?? null) || !preg_match('/^[a-f0-9]{64}$/D',$record['phone_hmac'])
                || !in_array($record['status'] ?? null,['submitted','confirmed','unknown','rejected','duplicate'],true))
                throw new RuntimeException('legacy_consent_unreadable');
            // Current guarded receipts are governed by the atomic ledger. A concurrent new receipt is not an old send.
            if (($record['registration_guard'] ?? '')==='phone-v1' || !hash_equals($record['phone_hmac'],$phoneKey) || $record['status']==='rejected') continue;
            $status=in_array($record['status'],['confirmed','duplicate'],true) ? 'confirmed' : 'unknown';
            if ($found===null || $status==='confirmed') $found=['status'=>$status,'receipt'=>$record['id']];
        }
        return $found;
    }
    /** Null grants this receipt the only permission to send. Other results must never call FlexBonus. */
    public function reserve(string $phone,string $receipt): ?array {
        if (!preg_match('/^[a-f0-9]{32}$/D',$receipt)) throw new RuntimeException('registration_receipt_invalid');
        $key=$this->phoneKey($phone); $now=time(); $this->db->exec('BEGIN IMMEDIATE');
        try {
            $read=$this->db->prepare('SELECT status,receipt FROM registrations WHERE phone_key=?');
            $read->execute([$key]); $row=$read->fetch(PDO::FETCH_ASSOC);
            if (!$row && ($legacy=$this->legacyStatus($phone))!==null) {
                $this->db->prepare('INSERT INTO registrations(phone_key,status,receipt,created_at,updated_at) VALUES(?,?,?,?,?)')->execute([$key,$legacy['status'],$legacy['receipt'],$now,$now]);
                $row=$legacy;
            }
            if ($row && $row['status']==='confirmed') {
                $result=['IsSuccess'=>true,'AlreadyRegistered'=>true,'Receipt'=>$row['receipt'],'Message'=>'Этот номер уже зарегистрирован через сайт. Повторно отправлять анкету не нужно.'];
            } elseif ($row && $row['status']!=='rejected') {
                // A worker may have stopped after sending but before saving the result. Never expire this into a retry.
                $result=['IsSuccess'=>false,'Outcome'=>'unknown','Receipt'=>$row['receipt'],'Message'=>'Заявка с этим номером уже отправлена, но её результат пока не подтверждён. Уточните регистрацию у кофейни.'];
            } else {
                $write=$this->db->prepare('INSERT INTO registrations(phone_key,status,receipt,created_at,updated_at) VALUES(?,\'pending\',?,?,?) ON CONFLICT(phone_key) DO UPDATE SET status=\'pending\',receipt=excluded.receipt,updated_at=excluded.updated_at');
                $write->execute([$key,$receipt,$now,$now]); $result=null;
            }
            $this->db->exec('COMMIT'); return $result;
        } catch (Throwable $e) { $this->db->exec('ROLLBACK'); throw $e; }
    }
    public function finish(string $phone,string $receipt,string $status): void {
        if (!in_array($status,['confirmed','unknown','rejected'],true)) throw new RuntimeException('registration_status_invalid');
        $update=$this->db->prepare('UPDATE registrations SET status=?,updated_at=? WHERE phone_key=? AND receipt=? AND status=\'pending\'');
        $update->execute([$status,time(),$this->phoneKey($phone),$receipt]);
        if ($update->rowCount()!==1) throw new RuntimeException('registration_owner_mismatch');
    }
}
