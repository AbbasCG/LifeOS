<?php

namespace App\Services\Discovery;

use RuntimeException;

/** A content file under resources/discovery is malformed; the message names the file and the field. */
class InvalidDiscoveryContentException extends RuntimeException {}
