CASE
  WHEN NOT json_valid(data) THEN NULL
  WHEN json_extract(data,'$.kind')='reconnect' AND json_extract(data,'$.barrier') IS NOT NULL THEN 0
  WHEN json_extract(data,'$.kind')='message'
    AND json_type(data,'$.input.text')='text'
    AND json_type(data,'$.input.telegramProtectedCommand') IS NOT 'true'
    -- Without a modern verdict, a changed Telegram routing view cannot grant
    -- priority to the original command. Keep that legacy receipt in FIFO.
    AND (
      json_extract(data,'$.input.route.platform') IS NOT 'telegram'
      OR json_type(data,'$.input.telegramProtectedCommand')='false'
      OR json_type(data,'$.input.routingText') IS NULL
      OR (data -> '$.input.routingText')=(data -> '$.input.text')
    )
    AND (
      trim(json_extract(data,'$.input.text'), {whitespace}) IN ('/restart','/stop')
      OR (
        substr(ltrim(json_extract(data,'$.input.text'), {whitespace}),1,5)='/stop'
        AND trim(substr(ltrim(json_extract(data,'$.input.text'), {whitespace}),6,1), {whitespace})=''
        AND trim(substr(ltrim(json_extract(data,'$.input.text'), {whitespace}),6), {whitespace})='head'
      )
    )
    -- Some SQLite string operations truncate at NUL or drop unpaired surrogates.
    -- Check the JSON string as encoded; neither escape can be part of an exact control.
    AND (data -> '$.input.text') NOT GLOB '*\u0000*'
    AND lower(data -> '$.input.text') NOT GLOB '*\ud[89abcdef][0-9a-f][0-9a-f]*'
  THEN 1
END
