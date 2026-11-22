# Move files into and out of Kandelo

Kandelo's files live inside its computer. To copy a file to your device,
run `kandelo-publish` in the Kandelo terminal, then click **Save** on the
output card that appears.

## Download a file

```sh
kandelo-publish ./report.pdf
```

The command prints an output ID and adds `report.pdf` to the browser app's
output tray. Click **Save** on its card to save it to your device. The browser
opens a file picker where supported; otherwise it starts a normal download.
**Dismiss** removes the card without saving it.

Paths such as `./report.pdf` refer to files inside Kandelo. Publishing makes
the output available to the app; a successful command does not mean the file
has been saved to your device. It does not upload the file to a website or
create a public link. In a custom browser app or a Node.js embedding, the
embedding application decides how to handle published outputs.

You can choose the download name and MIME type:

```sh
kandelo-publish --name results.csv --mime text/csv ./data/results.csv
```

`--name` is a filename, not a destination path on your device. Without it,
the command uses the source file's name. MIME metadata labels the content;
it does not convert it. Publish each file with a separate invocation.

## Download a directory

Archive directories before publishing them. For example, run these commands
from the directory containing `project`:

```sh
tar -czf /tmp/project.tar.gz project/
kandelo-publish /tmp/project.tar.gz
```

Click **Save** on the `project.tar.gz` card. The archive includes the folder's
contents and can be extracted on your device. This example requires `tar`
with gzip support in the Kandelo image.

## Stream command output

To export a command's stdout without first creating a regular file, give the
producer command to `kandelo-publish`:

```sh
kandelo-publish --stream --name project.tar.gz -- tar -czf - project/
```

The output card appears before the producer finishes. Click **Save** to start
reading it; the producer waits until a reader opens the stream. Where the
browser supports a streaming save picker, bytes go directly to the selected
file. Other browsers show **Buffer and download** and hold the whole output
in memory before downloading it. Prefer a browser with streaming saves for
large outputs.

The stream succeeds only if the producer exits with status 0. A nonzero exit
or signal marks it aborted and is reported as a save error. Use the command
form above rather than `producer | kandelo-publish`: the helper needs to
observe the producer's exit status and has no stdin-reading form.

## Command reference

For help inside Kandelo, run `kandelo-publish --help`. Images with the
`kandelo-exchange-docs` package also provide `man 1 kandelo-publish`.

```text
kandelo-publish [--mime TYPE] [--from ID]... [--name NAME] FILE
kandelo-publish --stream --name NAME [--mime TYPE] [--from ID]... -- CMD [ARGS...]
kandelo-publish --complete PATH
kandelo-publish --abort PATH REASON
```

| Option | Purpose |
| --- | --- |
| `--name NAME` | Output filename; required for streams. |
| `--mime TYPE` | Optional content type, such as `application/pdf`. |
| `--from ID` | Record an exchange input ID the output was derived from. Repeat for multiple inputs; ordinary downloads do not need this. |
| `--stream` | Publish a stream and run the command after `--` as its producer. |
| `--complete PATH` | Mark a published stream complete when your program manages the producer itself. |
| `--abort PATH REASON` | Mark a published stream aborted with a reason when your program manages the producer itself. |
| `--help` | Print usage, options, and behavior, then exit. |
| `--version` | Print version information, then exit. |

The `--complete` and `--abort` forms operate on a published stream's exchange path, not an
arbitrary file you want to download. Most users should use the `FILE` or
`--stream ... -- CMD` forms. Exchange handlers use their existing
`KANDELO_WORK` session; standalone invocations create their own work session.

Exit status is 0 on success, 64 for invalid arguments, and 1 for a publishing
failure. After a streamed producer runs, the helper returns its exit status,
or 128 plus the signal number if a signal ended it. Failure to start the
producer returns 127; failure to declare the stream's end after a successful
producer returns 1.

## Bring files into Kandelo

Drop files or folders onto the terminal or graphics surface, or use the
dock's **Send files** button. The machine's exchange handlers decide what
to do with them. The fallback saves them under `~/Downloads/`, preserving
folder structure and renaming colliding names. Some file types have specific
handlers, such as loading game data. The status card reports the result.

## For agents

Run `kandelo-publish` inside the guest computer as the configured guest
account. A WebMCP agent can use `kandelo_run_command`, for example:

```json
{ "script": "kandelo-publish /tmp/report.csv" }
```

Check the job's exit status and stderr, then tell the user which output card
to save. Report it as available to save until the save has actually been
observed. For a streamed export, the job may remain running while it waits
for the user to start reading; choose a job timeout long enough for that
interaction.

## If it does not work

- **Command not found:** the image needs the `kandelo-exchange` package,
  which provides `/usr/bin/kandelo-publish` in the standard computers.
- **Cannot read or publish:** check the source path, guest file permissions,
  and the error printed on stderr. Archive a directory before publishing it.
- **No output card:** check that the command succeeded and that your embedding
  handles exchange outputs. An output ID alone does not prove a host save.
- **Need a backup:** save the outputs to your device before clearing browser
  storage or updating Kandelo. Browser storage and an unsaved output card
  are not backups.
