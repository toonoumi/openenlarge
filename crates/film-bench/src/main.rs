mod manifest;
mod run;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() != 3 {
        eprintln!("usage: film-bench <manifest.json> <out_dir>");
        std::process::exit(2);
    }
    if let Err(e) = run::run(&args[1], &args[2]) {
        eprintln!("error: {e}");
        std::process::exit(1);
    }
}
