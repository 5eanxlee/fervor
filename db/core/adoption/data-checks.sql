-- Legacy V1 data-state proof. Every row must report zero before controlled baseline.
SELECT check_name, violations
FROM (
    SELECT 'active_alert_projection' AS check_name, count(*)::bigint AS violations
      FROM (
        SELECT a.token_address, count(*)::int AS expected, max(m.active_alert_count) AS actual
          FROM token_alerts a
          LEFT JOIN monitored_tokens m ON m.token_address = a.token_address
         WHERE a.is_active = true AND a.is_triggered = false
         GROUP BY a.token_address
        HAVING max(m.active_alert_count) IS DISTINCT FROM count(*)::int
      ) drift
    UNION ALL
    SELECT 'discord_token_state', count(*) FROM discord_linking_tokens WHERE token_hash IS NULL AND used = false
    UNION ALL
    SELECT 'extension_token_state', count(*) FROM extension_linking_tokens WHERE token_hash IS NULL AND used = false
    UNION ALL
    SELECT 'user_extension_state', count(*) FROM user_extensions WHERE extension_token_hash IS NULL AND revoked_at IS NULL
    UNION ALL
    SELECT 'telegram_preference', count(*)
      FROM users u
     WHERE u.telegram_chat_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_notification_preferences p
          WHERE p.user_id = u.id AND p.channel = 'telegram' AND p.enabled = true
       )
    UNION ALL
    SELECT 'discord_preference', count(*)
      FROM users u
     WHERE u.discord_user_id IS NOT NULL
       AND NOT EXISTS (
         SELECT 1 FROM user_notification_preferences p
          WHERE p.user_id = u.id AND p.channel = 'discord' AND p.enabled = true
       )
) checks
ORDER BY check_name;
