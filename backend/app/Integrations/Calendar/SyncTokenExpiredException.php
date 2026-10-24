<?php

namespace App\Integrations\Calendar;

/** An incremental sync token or delta link is no longer valid (HTTP 410). The caller must run a full sync. */
class SyncTokenExpiredException extends ProviderException {}
