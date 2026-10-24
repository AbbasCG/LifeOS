<?php

namespace App\Integrations\Calendar;

/** The provider rejected our credentials (revoked access, invalid_grant). Retrying will not help; the user must reconnect. */
class ProviderAuthException extends ProviderException {}
