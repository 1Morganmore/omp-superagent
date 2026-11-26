use super::{SlashTextError, control_text, slash_text};

#[test]
fn normalizes_only_exact_owner_command_spellings() {
    for (input, expected) in [
        ("!resolve held-input", "/resolve held-input"),
        ("!effort\u{feff}high", "/effort\u{feff}high"),
        ("!fast", "/fast"),
        ("!resolved", "!resolved"),
        ("quoted !resolve", "quoted !resolve"),
        (" !new request", " !new request"),
        ("!model\u{85}model", "!model\u{85}model"),
    ] {
        assert_eq!(control_text(input.into()), expected);
    }
    assert_eq!(
        slash_text("/superagent-model", " exact\nargument \u{feff} ").as_deref(),
        Ok("/model exact\nargument")
    );
    assert_eq!(
        slash_text("/superagent-status", "not accepted"),
        Err(SlashTextError::UnexpectedArgument)
    );
    assert_eq!(
        slash_text("/superagent-fast", "ultra"),
        Err(SlashTextError::UnexpectedArgument)
    );
    assert_eq!(slash_text("/status", ""), Err(SlashTextError::Unregistered));
}

#[test]
fn slash_ingress_accepts_only_the_registered_names_and_argument_contract() {
    for command in crate::commands::catalog() {
        let name = format!("/superagent-{}", command.name);
        assert_eq!(
            slash_text(&name, " \n "),
            Ok(format!("/{}", command.name))
        );
        assert_eq!(
            slash_text(&name, "input"),
            command.text
                .map(|_| format!("/{} input", command.name))
                .ok_or(SlashTextError::UnexpectedArgument)
        );
        assert_eq!(
            slash_text(&format!("/{}", command.name), ""),
            Err(SlashTextError::Unregistered)
        );
        assert_eq!(
            slash_text(&format!("!{}", command.name), ""),
            Err(SlashTextError::Unregistered)
        );
    }
    for name in [
        "/hermes",
        "/superagent-models",
        "/superagent-help extra",
        "/SUPERAGENT-help",
        "superagent-help",
    ] {
        assert_eq!(slash_text(name, ""), Err(SlashTextError::Unregistered));
    }
    for (name, input, expected) in [
        (
            "/superagent-model",
            "  --global provider/model  ",
            "/model --global provider/model",
        ),
        ("/superagent-usage", " reset ", "/usage reset"),
        ("/superagent-fast", " ", "/fast"),
        (
            "/superagent-compact",
            "  first line\nsecond line  ",
            "/compact first line\nsecond line",
        ),
        (
            "/superagent-new",
            "start\nwith context",
            "/new start\nwith context",
        ),
        (
            "/superagent-stop",
            "actual-lane-id",
            "/stop actual-lane-id",
        ),
    ] {
        assert_eq!(slash_text(name, input).as_deref(), Ok(expected));
    }
}
