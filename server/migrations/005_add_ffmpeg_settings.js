export function up(db) {
  // Add FFmpeg settings
  db.exec(`
    INSERT OR IGNORE INTO settings (key, value) VALUES
      ('ffmpeg_enabled', 'false'),
      ('ffmpeg_web_player', 'true'),
      ('ffmpeg_output_format', 'mpegts'),
      ('ffmpeg_video_codec', 'libx264'),
      ('ffmpeg_audio_codec', 'aac'),
      ('ffmpeg_preset', 'veryfast'),
      ('ffmpeg_tune', 'zerolatency'),
      ('ffmpeg_gop_size', '60'),
      ('ffmpeg_video_bitrate', '4000k'),
      ('ffmpeg_pixel_format', 'yuv420p'),
      ('ffmpeg_custom_params', ''),
      ('ffmpeg_web_format', 'mp4'),
      ('ffmpeg_web_video_codec', 'copy'),
      ('ffmpeg_web_audio_codec', 'copy'),
      ('ffmpeg_web_params', '-movflags frag_keyframe+empty_moov+default_base_moof')
  `)
}

export function down(db) {
  db.exec(`
    DELETE FROM settings WHERE key IN (
      'ffmpeg_enabled',
      'ffmpeg_web_player',
      'ffmpeg_output_format',
      'ffmpeg_video_codec',
      'ffmpeg_audio_codec',
      'ffmpeg_preset',
      'ffmpeg_tune',
      'ffmpeg_gop_size',
      'ffmpeg_video_bitrate',
      'ffmpeg_pixel_format',
      'ffmpeg_custom_params',
      'ffmpeg_web_format',
      'ffmpeg_web_video_codec',
      'ffmpeg_web_audio_codec',
      'ffmpeg_web_params'
    )
  `)
}
