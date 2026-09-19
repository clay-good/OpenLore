class Repo {
  Repo find(int id) => this;
  void insert(Repo r) {}
}

String format(String s) => s;
List<int> map(List<int> xs) => xs;

class Service {
  void run(Repo repo) {
    final r = repo.find(1);
    repo.insert(r);
    print(format('x'));
    final xs = [1, 2].where((x) => x > 0).map((x) => x);
  }
}
