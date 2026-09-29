<?php
declare(strict_types=1);

// Copy to the PRIVATE directory as orders-config.php. Never put it in public_html.
// No working café terms are invented here. Empty values keep ordering disabled.
// Root deployment updates must preserve this file and orders-data/orders.sqlite.
return [
    'enabled'=>false,
    'mode'=>'production',
    'termsApproved'=>false, // Set only after the owner approved every operational/legal field below.
    'notice'=>'',
    'timezone'=>'Europe/Moscow', // Technical assumption: confirm before enabling.
    'cafeAddress'=>'', 'cafePhone'=>'', 'defaultCity'=>'',
    // Monday=1 ... Sunday=7. Multiple sorted nonoverlapping intervals are supported.
    // [] means closed; split overnight hours across adjacent days. End may be 24:00.
    'schedule'=>[
        'acceptance'=>[1=>[],2=>[],3=>[],4=>[],5=>[],6=>[],7=>[]],
        'pickup'=>[1=>[],2=>[],3=>[],4=>[],5=>[],6=>[],7=>[]],
        'delivery'=>[1=>[],2=>[],3=>[],4=>[],5=>[],6=>[],7=>[]],
    ],
    'closedDates'=>[], // YYYY-MM-DD, in the configured time zone.
    'minDelayMinutes'=>['pickup'=>null,'delivery'=>null],
    'slotMinutes'=>null, 'maxPreorderDays'=>null, 'allowPreorderOutsideHours'=>null,
    'maxLines'=>50, 'maxQuantity'=>99, // Technical caps, not the café's approved commercial limits.
    'minimumSubtotalMinor'=>['pickup'=>null,'delivery'=>null],
    'delivery'=>[
        'mode'=>null, // Explicitly choose fixed OR confirm_by_phone.
        'feeMinor'=>null, 'freeFromMinor'=>null, // Integer kopecks; both null for confirm_by_phone.
        'zoneNotice'=>'', // Explain that an employee manually confirms the address/zone.
    ],
    'consent'=>['version'=>'','text'=>'','url'=>''], // Same-origin /order-terms.html with APPROVED order-specific text.
    'paymentNotice'=>'', // Approved wording; no payment method/integration is implemented.
];
