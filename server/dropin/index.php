<?php
/**
 * DayOne Pages — entry point ("drop into the site folder" version).
 *
 * nginx must send EVERY path to this file. It works out the requested domain
 * and path, asks Supabase (with a 1-minute cache in _cache/) and returns the
 * page. Configure it in config.php; don't edit _dayone/.
 */
declare(strict_types=1);

define('DAYONE_ENTRY', true);

require __DIR__ . '/_dayone/bootstrap.php';

dayone_handle();
