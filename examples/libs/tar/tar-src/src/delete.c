/* Delete entries from a tar archive.

   Copyright 1988-2023 Free Software Foundation, Inc.

   This file is part of GNU tar.

   GNU tar is free software; you can redistribute it and/or modify
   it under the terms of the GNU General Public License as published by
   the Free Software Foundation; either version 3 of the License, or
   (at your option) any later version.

   GNU tar is distributed in the hope that it will be useful,
   but WITHOUT ANY WARRANTY; without even the implied warranty of
   MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
   GNU General Public License for more details.

   You should have received a copy of the GNU General Public License
   along with this program.  If not, see <http://www.gnu.org/licenses/>.  */

#include <system.h>

#include "common.h"
#include <rmt.h>

static union block *new_record;
static int new_blocks;
static bool acting_as_filter;

/* FIXME: This module should not directly handle the following
   variables, instead, the interface should be cleaned up.  */
extern union block *record_start;
extern union block *record_end;
extern union block *current_block;
extern union block *recent_long_name;
extern union block *recent_long_link;
extern off_t records_read;

/* The number of records skipped at the start of the archive, when
   passing over members that are not deleted.  */
off_t records_skipped;

/* Move archive descriptor by COUNT records worth.  If COUNT is
   positive we move forward, else we move negative.  If it's a tape,
   MTIOCTOP had better work.  If it's something else, we try to seek
   on it.  If we can't seek, we lose!  */
static void
move_archive (off_t count)
{
  if (count == 0)
    return;

  if (mtioseek (false, count))
    return;

  off_t position0 = rmtlseek (archive, 0, SEEK_CUR), position = 0;
  if (0 <= position0)
    {
      /* Pretend the starting position is at the first record
	 boundary after POSITION0.  This is useful at EOF after
	 a short read.  */
      idx_t short_size = position0 % record_size;
      idx_t start_offset = short_size ? record_size - short_size : 0;
      off_t increment, move_start;
      if (INT_MULTIPLY_WRAPV (record_size, count, &increment)
	  || INT_ADD_WRAPV (position0, start_offset, &move_start)
	  || INT_ADD_WRAPV (move_start, increment, &position)
	  || position < 0)
	{
	  ERROR ((0, EOVERFLOW, "lseek: %s", archive_name_array[0]));
	  return;
	}
      else if (rmtlseek (archive, position, SEEK_SET) == position)
	return;
    }
  if (!_isrmt (archive))
    seek_error_details (archive_name_array[0], position);
}

/* Write out the record which has been filled.  If MOVE_BACK_FLAG,
   backspace to where we started.  */
static void
write_record (int move_back_flag)
{
  union block *save_record = record_start;
  record_start = new_record;

  if (acting_as_filter)
    {
      archive = STDOUT_FILENO;
      flush_write ();
      archive = STDIN_FILENO;
    }
  else
    {
      move_archive ((records_written + records_skipped) - records_read);
      flush_write ();
    }

  record_start = save_record;

  if (move_back_flag)
    {
      /* Move the tape head back to where we were.  */

      if (! acting_as_filter)
	move_archive (records_read - (records_written + records_skipped));
    }

  new_blocks = 0;
}

static void
write_recent_blocks (union block *h, size_t blocks)
{
  size_t i;
  for (i = 0; i < blocks; i++)
    {
      new_record[new_blocks++] = h[i];
      if (new_blocks == blocking_factor)
	write_record (1);
    }
}

static void
write_recent_bytes (char *data, size_t bytes)
{
  size_t blocks = bytes / BLOCKSIZE;
  size_t rest = bytes - blocks * BLOCKSIZE;

  write_recent_blocks ((union block *)data, blocks);
  memcpy (new_record[new_blocks].buffer, data + blocks * BLOCKSIZE, rest);
  if (rest < BLOCKSIZE)
    memset (new_record[new_blocks].buffer + rest, 0, BLOCKSIZE - rest);
  new_blocks++;
  if (new_blocks == blocking_factor)
    write_record (1);
}

static void
flush_file (void)
{
  off_t blocks_to_skip;

  set_next_block_after (current_header);
  blocks_to_skip = (current_stat_info.stat.st_size
			  + BLOCKSIZE - 1) / BLOCKSIZE;

  while (record_end - current_block <= blocks_to_skip)
    {
      blocks_to_skip -= (record_end - current_block);
      flush_archive ();
      if (record_end == current_block)
	/* Hit EOF */
	break;
    }
  current_block += blocks_to_skip;
}

void
delete_archive_members (void)
{
  enum read_header logical_status = HEADER_STILL_UNREAD;
  enum read_header previous_status = HEADER_STILL_UNREAD;

  /* FIXME: Should clean the routine before cleaning these variables :-( */
  struct name *name;
  off_t blocks_to_keep = 0;
  int kept_blocks_in_record;

  name_gather ();
  open_archive (ACCESS_UPDATE);
  acting_as_filter = strcmp (archive_name_array[0], "-") == 0;

  /* Skip to the first member that matches the name list. */
  do
    {
      enum read_header status = read_header (&current_header,
					     &current_stat_info,
					     read_header_x_raw);

      switch (status)
	{
	case HEADER_STILL_UNREAD:
	  abort ();

	case HEADER_SUCCESS:
	  if ((name = name_scan (current_stat_info.file_name, false)) == NULL)
	    {
	      skim_member (acting_as_filter);
	      break;
	    }
	  name->found_count++;
	  if (!ISFOUND (name))
	    {
	      skim_member (acting_as_filter);
	      break;
	    }
	  FALLTHROUGH;
	case HEADER_SUCCESS_EXTENDED:
	  logical_status = status;
	  break;

	case HEADER_ZERO_BLOCK:
	  if (ignore_zeros_option)
	    {
	      set_next_block_after (current_header);
	      break;
	    }
	  FALLTHROUGH;
	case HEADER_END_OF_FILE:
	  logical_status = HEADER_END_OF_FILE;
	  break;

	case HEADER_FAILURE:
	  set_next_block_after (current_header);
	  switch (previous_status)
	    {
	    case HEADER_STILL_UNREAD:
	      WARN ((0, 0, _("This does not look like a tar archive")));
	      FALLTHROUGH;
	    case HEADER_SUCCESS:
	    case HEADER_SUCCESS_EXTENDED:
	    case HEADER_ZERO_BLOCK:
	      ERROR ((0, 0, _("Skipping to next header")));
	      FALLTHROUGH;
	    case HEADER_FAILURE:
	      break;

	    case HEADER_END_OF_FILE:
	      abort ();
	    }
	  break;
	}

      previous_status = status;
    }
  while (logical_status == HEADER_STILL_UNREAD);

  records_skipped = records_read - 1;
  new_record = xmalloc (record_size);

  if (logical_status == HEADER_SUCCESS
      || logical_status == HEADER_SUCCESS_EXTENDED)
    {
      write_archive_to_stdout = false;

      /* Save away blocks before this one in this record.  */

      new_blocks = current_block - record_start;
      if (new_blocks)
	memcpy (new_record, record_start, new_blocks * BLOCKSIZE);

      if (logical_status == HEADER_SUCCESS)
	{
	  logical_status = HEADER_STILL_UNREAD;
	  flush_file ();
	}

      /* Skip matching members and move the rest up the archive. */
      while (logical_status != HEADER_END_OF_FILE)
	{
	  enum read_header status;

	  /* Fill in a record.  */

	  if (current_block == record_end)
	    flush_archive ();

	  status = read_header (&current_header, &current_stat_info,
				read_header_auto);

	  switch (status)
	    {
	    case HEADER_STILL_UNREAD:
	    case HEADER_SUCCESS_EXTENDED:
	      abort ();

	    case HEADER_SUCCESS:
	      /* Found another header.  */
	      xheader_decode (&current_stat_info);

	      if ((name = name_scan (current_stat_info.file_name, false)) != NULL)
		{
		  name->found_count++;
		  if (ISFOUND (name))
		    {
		      flush_file ();
		      break;
		    }
		}
	      /* Copy header.  */

	      if (current_stat_info.xhdr.size)
		{
		  write_recent_bytes (current_stat_info.xhdr.buffer,
				      current_stat_info.xhdr.size);
		}
	      else
		{
		  write_recent_blocks (recent_long_name,
				       recent_long_name_blocks);
		  write_recent_blocks (recent_long_link,
				       recent_long_link_blocks);
		}
	      new_record[new_blocks] = *current_header;
	      new_blocks++;
	      blocks_to_keep
		= (current_stat_info.stat.st_size + BLOCKSIZE - 1) / BLOCKSIZE;
	      set_next_block_after (current_header);
	      if (new_blocks == blocking_factor)
		write_record (1);

	      /* Copy data.  */

	      kept_blocks_in_record = record_end - current_block;
	      if (kept_blocks_in_record > blocks_to_keep)
		kept_blocks_in_record = blocks_to_keep;

	      while (blocks_to_keep)
		{
		  int count;

		  if (current_block == record_end)
		    {
		      flush_read ();
		      current_block = record_start;
		      kept_blocks_in_record = blocking_factor;
		      if (kept_blocks_in_record > blocks_to_keep)
			kept_blocks_in_record = blocks_to_keep;
		    }
		  count = kept_blocks_in_record;
		  if (blocking_factor - new_blocks < count)
		    count = blocking_factor - new_blocks;

		  if (! count)
		    abort ();

		  memcpy (new_record + new_blocks, current_block,
			  count * BLOCKSIZE);
		  new_blocks += count;
		  current_block += count;
		  blocks_to_keep -= count;
		  kept_blocks_in_record -= count;

		  if (new_blocks == blocking_factor)
		    write_record (1);
		}
	      break;

	    case HEADER_ZERO_BLOCK:
	      if (ignore_zeros_option)
		set_next_block_after (current_header);
	      else
		logical_status = HEADER_END_OF_FILE;
	      break;

	    case HEADER_END_OF_FILE:
	      logical_status = HEADER_END_OF_FILE;
	      break;

	    case HEADER_FAILURE:
	      ERROR ((0, 0, _("Deleting non-header from archive")));
	      set_next_block_after (current_header);
	      break;

	    default:
	      abort ();
	    }
	  tar_stat_destroy (&current_stat_info);
	}

      if (logical_status == HEADER_END_OF_FILE)
	{
	  /* Write the end of tape.  FIXME: we can't use write_eot here,
	     as it gets confused when the input is at end of file.  */

	  int total_zero_blocks = 0;

	  do
	    {
	      int zero_blocks = blocking_factor - new_blocks;
	      memset (new_record + new_blocks, 0, BLOCKSIZE * zero_blocks);
	      total_zero_blocks += zero_blocks;
	      write_record (total_zero_blocks < 2);
	    }
	  while (total_zero_blocks < 2);
	}

      if (! acting_as_filter && ! _isrmt (archive))
	{
	  if (sys_truncate (archive))
	    truncate_warn (archive_name_array[0]);
	}
    }
  free (new_record);

  close_archive ();
  names_notfound ();
}
