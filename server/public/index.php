<?php
/**
 * The only file in the webroot. Everything (any host, any path) lands here.
 */
declare(strict_types=1);

define('DAYONE_ENTRY', true);

require __DIR__ . '/../src/bootstrap.php';

dayone_handle();
