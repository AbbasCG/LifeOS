<?php

namespace App\Integrations\Calendar;

use RuntimeException;

/** A transient provider failure (network, 5xx, rate limit). Safe to retry. */
class ProviderException extends RuntimeException {}
