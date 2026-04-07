export function addShareOption(command) {
  return command.addBooleanOption((option) =>
    option
      .setName("share")
      .setDescription("ON이면 채널에 공개하고, OFF면 본인에게만 보여준다냥."),
  );
}

export function addShareOptionToSubcommand(subcommand) {
  return subcommand.addBooleanOption((option) =>
    option
      .setName("share")
      .setDescription("ON이면 채널에 공개하고, OFF면 본인에게만 보여준다냥."),
  );
}
