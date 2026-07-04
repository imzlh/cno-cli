// Target for CDP discovery test: stays alive so /json and WS endpoint exist.
let counter = 0;
while (true) {
    counter++;
    await new Promise((resolve) => setTimeout(resolve, 500));
}
